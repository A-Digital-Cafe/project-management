import type { Model } from "mongoose";
import type { Block } from "@common/ADC/types/learning.ts";
import type { Issue } from "@common/types/project-manager/Issue.ts";
import { ProjectManagerError } from "@common/types/custom-errors/ProjectManagerError.ts";
import type {
	CreateSupportTicketInput,
	SupportTicketIssueResponse,
	SupportTicketCaller,
	SupportTicketConfig,
} from "@common/types/project-manager/SupportTicket.ts";
import { TICKET_TYPE_LABELS } from "@common/types/project-manager/SupportTicket.ts";
import { TICKET_COLUMN_MAP, TICKET_TYPE_CATEGORIES, ensureTicketBoard, type CommonTicketColumnKey } from "../boards.ts";
import type { ILogger } from "@interfaces/utils/ILogger.js";
import { sha256Hex } from "@common/utils/crypto.ts";
import type { CustomFieldValue } from "@common/types/project-manager/CustomField.ts";
import { deriveBugBountyStatus, type BugBountyPublicEntry } from "@common/types/project-manager/BugBounty.ts";
import type { IssueManager } from "./issues.js";
import type { ProjectManager } from "./projects.js";
import { redactLabeledParagraphs } from "./redact.ts";

export class SupportTicketManager {
	constructor(
		private readonly projects: ProjectManager,
		private readonly issues: IssueManager,
		private readonly issueModel: Model<Issue>,
		private readonly kernelKey: symbol,
		private readonly logger: ILogger,
		private readonly config: SupportTicketConfig = {}
	) {}

	async create(kernelKey: symbol, input: CreateSupportTicketInput, caller: SupportTicketCaller): Promise<SupportTicketIssueResponse> {
		this.#projectSlug(); // valida configuración antes de tocar la base.
		// Autogenera/reconcilia el tablero en la propia request: si falta el proyecto,
		// una columna o un campo canónico, el ticket no queda huérfano esperando al
		// próximo arranque del servicio.
		const project = await ensureTicketBoard({ projects: this.projects, logger: this.logger }, kernelKey, "tickets", this.config);
		if (!project) {
			throw new ProjectManagerError(
				503,
				"SUPPORT_TICKET_PROJECT_UNAVAILABLE",
				"El proyecto configurado para tickets de soporte no existe"
			);
		}

		// Asignar columna según el tipo de ticket (tipada)
		const columnKey: CommonTicketColumnKey = TICKET_COLUMN_MAP[input.type];

		const issue = await this.issues.createInternal(
			kernelKey,
			project,
			{
				title: `[${TICKET_TYPE_LABELS[input.type]}] ${input.title}`,
				description: supportTicketBlocks(input, caller),
				category: TICKET_TYPE_CATEGORIES[input.type],
				columnKey,
				customFields: supportTicketCustomFields(input, caller),
			},
			caller.userId
		);

		return {
			ticketId: issue.id,
			ticketKey: issue.key,
			message: `Ticket creado. El ID es ${issue.key}.`,
		};
	}

	/**
	 * Log público de transparencia del bug bounty. Sin auth: id, fecha/hora, hash,
	 * estado y severidad son siempre públicos. La **descripción original** solo se
	 * publica si el ticket está `resolved` y el reporter pidió divulgación
	 * (`publicDisclosure === "true"`); el **handle** además exige `wantsCredit`.
	 */
	async listPublicBugBounty(kernelKey: symbol): Promise<BugBountyPublicEntry[]> {
		const slug = this.#projectSlug();
		const project = await this.projects.getInternals(kernelKey).fetchGlobalProjectBySlug(slug);
		if (!project) return [];

		const columnName = new Map(project.kanbanColumns.map((c) => [c.key, c.name]));
		const issues = await this.issues.listBugBountyInternal(kernelKey, project.id);

		return issues.map((issue) => {
			const cf = (issue.customFields ?? {});
			// El estado se deriva de la columna actual del ticket en el tablero del PM.
			const status = deriveBugBountyStatus(issue.columnKey, columnName.get(issue.columnKey));
			const disclosed = cf.publicDisclosure === "true";
			const wantsCredit = cf.wantsCredit === "true";
			// Publicar los pasos de reproducción antes del fix sería divulgar un 0-day:
			// la descripción sale sólo con el ticket resuelto Y consentimiento explícito.
			// El hash, en cambio, no revela nada y es la prueba de no-manipulación.
			const published = status === "resolved" && disclosed;
			const reportedAt = typeof cf.reportedAt === "string" ? cf.reportedAt : issue.createdAt.toISOString();

			return {
				ticketKey: issue.key,
				reportedAt,
				descriptionHash: typeof cf.descriptionHash === "string" ? cf.descriptionHash : "",
				status,
				severity: (cf.severity as BugBountyPublicEntry["severity"]) ?? null,
				creditHandle: disclosed && wantsCredit && typeof cf.creditName === "string" ? cf.creditName : null,
				description: published && typeof cf.originalDescription === "string" ? cf.originalDescription : null,
			};
		});
	}

	/**
	 * Desvincula de un usuario los tickets que abrió (purga de cuenta). Los tickets
	 * viven en un proyecto global, así que no los alcanza la cascada de proyectos
	 * privados: hay que anonimizarlos acá. Se conserva el ticket (contenido
	 * operativo del soporte) y su hash; se borran los emails, el vínculo con el
	 * usuario y el handle de crédito — el consentimiento de atribución muere con
	 * la cuenta. Uso interno, protegido por `kernelKey`.
	 */
	async anonymizeReporter(kernelKey: symbol, userId: string): Promise<number> {
		if (kernelKey !== this.kernelKey) throw new Error("Acceso denegado: kernel key inválida");
		if (!userId) return 0;

		const docs = await this.issueModel
			.find({ "customFields.type": "support_ticket", "customFields.reportedByUserId": userId }, { id: 1, description: 1 })
			.lean<{ id: string; description: unknown }[]>();

		for (const doc of docs) {
			const patch: Record<string, unknown> = {
				reporterId: "",
				updatedAt: new Date(),
				"customFields.reporterEmail": null,
				"customFields.reportedByEmail": null,
				"customFields.reportedByUserId": null,
				"customFields.creditName": null,
			};
			if (Array.isArray(doc.description)) patch.description = redactLabeledParagraphs(doc.description as Block[], REPORTER_LABELS);
			await this.issueModel.updateOne({ id: doc.id }, { $set: patch });
		}

		return docs.length;
	}

	#projectSlug(): string {
		const slug =
			this.config.supportTicketsProjectId?.trim() ||
			this.config.orgManagementProjectId?.trim() ||
			"";

		if (!slug) {
			throw new ProjectManagerError(
				503,
				"SUPPORT_TICKET_PROJECT_NOT_CONFIGURED",
				"Falta configurar PM_SUPPORT_TICKETS_PROJECT_ID o ORG_MANAGEMENT_PROJECT_ID (slug del proyecto) para crear tickets de soporte"
			);
		}
		return slug;
	}
}

/**
 * Etiquetas de los párrafos que llevan datos personales del reporter. Se generan
 * y se redactan por acá: si cambia una, la purga tiene que seguir encontrándola.
 */
const REPORTER_LABELS = {
	contactEmail: "Email de contacto",
	reporterUser: "Usuario reportante",
	sessionEmail: "Email de sesión",
	credit: "Crédito público",
} as const;

/** Suma `n` días hábiles (lun-vie) a una fecha. */
function addBusinessDays(from: Date, n: number): Date {
	const d = new Date(from);
	let added = 0;
	while (added < n) {
		d.setUTCDate(d.getUTCDate() + 1);
		const day = d.getUTCDay();
		if (day !== 0 && day !== 6) added++;
	}
	return d;
}

function supportTicketCustomFields(input: CreateSupportTicketInput, caller: SupportTicketCaller): Record<string, CustomFieldValue> {
	const base: Record<string, CustomFieldValue> = {
		type: "support_ticket",
		ticketType: input.type,
		ticketTitle: input.title,
		reporterEmail: input.email,
		reportedByUserId: caller.userId,
		reportedByEmail: caller.email ?? null,
	};

	// ── Bug bounty: campos estructurados para triage, SLA y transparencia ──
	// (customFields solo admite string|number|Date|string[]|null, así que los
	//  flags booleanos se codifican como "true"/"false").
	if (input.type === "security") {
		const now = new Date();
		return {
			...base,
			bugBounty: "true",
			// Hash público de la descripción original (log de transparencia).
			descriptionHash: sha256Hex(input.description),
			// Copia canónica que se revela al resolver (si hay crédito); debe matchear el hash.
			originalDescription: input.description,
			reportedAt: now.toISOString(),
			// SLA: acuse +7 días hábiles, ETA inicial +30 días hábiles.
			slaAckDueAt: addBusinessDays(now, 7).toISOString(),
			slaEtaDueAt: addBusinessDays(now, 30).toISOString(),
			// Triage / recompensa (los completa el admin).
			severity: null,
			rewardPreference: input.rewardPreference ?? null,
			rewardGranted: null,
			// Crédito / disclosure.
			wantsCredit: input.wantsCredit === true ? "true" : "false",
			creditName: input.wantsCredit ? input.creditName ?? null : null,
			publicDisclosure: "false",
			addedToAcknowledgments: "false",
		};
	}

	return base;
}

function supportTicketBlocks(input: CreateSupportTicketInput, caller: SupportTicketCaller): Block[] {
	const blocks: Block[] = [
		{ type: "heading", level: 3, text: `Ticket de ${TICKET_TYPE_LABELS[input.type].toLowerCase()}` },
		{ type: "paragraph", text: `Tipo: ${TICKET_TYPE_LABELS[input.type]}` },
		{ type: "paragraph", text: `${REPORTER_LABELS.contactEmail}: ${input.email}` },
		{ type: "heading", level: 3, text: "Descripción" },
		{ type: "paragraph", text: input.description },
	];

	blocks.push(
		{ type: "heading", level: 3, text: "Información del reporte" },
		{ type: "paragraph", text: `${REPORTER_LABELS.reporterUser}: ${caller.userId}` },
		{ type: "paragraph", text: `${REPORTER_LABELS.sessionEmail}: ${caller.email || "Anónimo"}` }
	);

	// Recordatorio interno (solo admin) para tickets de seguridad / bug bounty.
	if (input.type === "security") {
		const wantsCredit = input.wantsCredit === true;
		const creditName = wantsCredit ? `SÍ (handle: ${input.creditName || "sin especificar"})` : "no";
		blocks.push(
			{ type: "heading", level: 3, text: "Bug bounty — pasos internos (no público)" },
			{ type: "paragraph", text: `${REPORTER_LABELS.credit}: ${creditName}` },
			{ type: "paragraph", text: `Preferencia de recompensa: ${input.rewardPreference ?? "sin preferencia"}.` },
			{ type: "paragraph", text: "1) Triage: reproducir y asignar severidad (low/medium/high/critical) en customFields.severity." },
			{ type: "paragraph", text: "2) SLA: acusar recibo (slaAckDueAt) y dar ETA (slaEtaDueAt)." },
			{ type: "paragraph", text: "3) Fix + tests + versión parche; mover la tarjeta a la columna de estado correspondiente." },
			{
				type: "paragraph",
				text: "4) Recompensa: otorgar upgrade temporal de tier (plus/pro) según severidad y preferencia, vía endpoint de grants de Identity (reportedByUserId). Registrar en customFields.rewardGranted.",
			},
			{
				type: "paragraph",
				text: "5) Disclosure: recién con el ticket resuelto y el OK del reporter, marcar customFields.publicDisclosure=\"true\" para publicar la descripción en el log de transparencia (/status/bounty, debe coincidir con descriptionHash). El handle sale sólo si además wantsCredit=\"true\"; registrar addedToAcknowledgments.",
			}
		);
	}

	return blocks;
}
