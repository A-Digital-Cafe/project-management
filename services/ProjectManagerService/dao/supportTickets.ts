import type { Block } from "@common/ADC/types/learning.ts";
import { ProjectManagerError } from "@common/types/custom-errors/ProjectManagerError.ts";
import type {
	CreateSupportTicketInput,
	SupportTicketIssueResponse,
	SupportTicketCaller,
	SupportTicketConfig,
} from "@common/types/project-manager/SupportTicket.ts";
import { TICKET_TYPE_LABELS } from "@common/types/project-manager/SupportTicket.ts";
import { TICKET_COLUMN_MAP, TICKET_TYPE_CATEGORIES, type CommonTicketColumnKey } from "../boards.ts";
import { sha256Hex } from "@common/utils/crypto.ts";
import type { CustomFieldValue } from "@common/types/project-manager/CustomField.ts";
import { deriveBugBountyStatus, type BugBountyPublicEntry } from "@common/types/project-manager/BugBounty.ts";
import type { IssueManager } from "./issues.js";
import type { ProjectManager } from "./projects.js";

export class SupportTicketManager {
	constructor(
		private readonly projects: ProjectManager,
		private readonly issues: IssueManager,
		private readonly config: SupportTicketConfig = {}
	) {}

	async create(kernelKey: symbol, input: CreateSupportTicketInput, caller: SupportTicketCaller): Promise<SupportTicketIssueResponse> {
		const slug = this.#projectSlug();
		const project = await this.projects.getInternals(kernelKey).fetchGlobalProjectBySlug(slug);
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
	 * Log público de transparencia del bug bounty: id, fecha/hora, hash, estado,
	 * severidad y descripción original (siempre públicos). El único dato redactado
	 * es el **handle del reporter**, que solo se incluye si dio consentimiento
	 * (`publicDisclosure === "true"` y `wantsCredit`). Sin auth.
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
			// El consentimiento (publicDisclosure + wantsCredit) solo gatea el HANDLE
			// del reporter; la descripción y el hash son siempre públicos (transparencia).
			const disclosed = cf.publicDisclosure === "true";
			const wantsCredit = cf.wantsCredit === "true";
			const reportedAt = typeof cf.reportedAt === "string" ? cf.reportedAt : issue.createdAt.toISOString();

			return {
				ticketKey: issue.key,
				reportedAt,
				descriptionHash: typeof cf.descriptionHash === "string" ? cf.descriptionHash : "",
				status,
				severity: (cf.severity as BugBountyPublicEntry["severity"]) ?? null,
				creditHandle: disclosed && wantsCredit && typeof cf.creditName === "string" ? cf.creditName : null,
				description: typeof cf.originalDescription === "string" ? cf.originalDescription : null,
			};
		});
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
		{ type: "paragraph", text: `Email de contacto: ${input.email}` },
		{ type: "heading", level: 3, text: "Descripción" },
		{ type: "paragraph", text: input.description },
	];

	blocks.push(
		{ type: "heading", level: 3, text: "Información del reporte" },
		{ type: "paragraph", text: `Usuario reportante: ${caller.userId}` },
		{ type: "paragraph", text: `Email de sesión: ${caller.email || "Anónimo"}` }
	);

	// Recordatorio interno (solo admin) para tickets de seguridad / bug bounty.
	if (input.type === "security") {
		const wantsCredit = input.wantsCredit === true;
		const creditName = wantsCredit ? `SÍ (handle: ${input.creditName || "sin especificar"})` : "no";
		blocks.push(
			{ type: "heading", level: 3, text: "Bug bounty — pasos internos (no público)" },
			{
				type: "paragraph",
				text:
					`Crédito público: ${creditName}. ` +
					`Preferencia de recompensa: ${input.rewardPreference ?? "sin preferencia"}.`,
			},
			{ type: "paragraph", text: "1) Triage: reproducir y asignar severidad (low/medium/high/critical) en customFields.severity." },
			{ type: "paragraph", text: "2) SLA: acusar recibo (slaAckDueAt) y dar ETA (slaEtaDueAt)." },
			{ type: "paragraph", text: "3) Fix + tests + versión parche; mover la tarjeta a la columna de estado correspondiente." },
			{
				type: "paragraph",
				text: "4) Recompensa: otorgar upgrade temporal de tier (plus/pro) según severidad y preferencia, vía endpoint de grants de Identity (reportedByUserId). Registrar en customFields.rewardGranted.",
			},
			{
				type: "paragraph",
				text: "5) Disclosure: si aceptó crédito, marcar customFields.publicDisclosure=\"true\" para publicar la descripción en el log de transparencia (/status/bounty, debe coincidir con descriptionHash) y registrar addedToAcknowledgments.",
			}
		);
	}

	return blocks;
}
