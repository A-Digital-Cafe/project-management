import type { Model } from "mongoose";
import type { Block } from "@common/ADC/types/learning.ts";
import type { Issue } from "@common/types/project-manager/Issue.ts";
import { ProjectManagerError } from "@common/types/custom-errors/ProjectManagerError.ts";
import type { CreateOrganizationRequestInput, OrganizationRequestIssueResponse } from "@common/types/project-manager/OrganizationRequest.ts";
import { ORG_REQUEST_COLUMN_KEY, ensureTicketBoard, type CommonTicketColumnKey } from "../boards.ts";
import type { ILogger } from "@interfaces/utils/ILogger.js";
import type { IssueManager } from "./issues.js";
import type { ProjectManager } from "./projects.js";
import { redactLabeledParagraphs } from "./redact.ts";

export interface OrganizationRequestCaller {
	userId: string;
	email?: string;
	ip: string;
}

interface OrganizationRequestConfig {
	organizationRequestsProjectId?: string;
	orgManagementProjectId?: string;
}

/** Párrafos del bloque "Solicitante": los únicos con datos personales de quien pidió el alta. */
const REQUESTER_LABELS = {
	userId: "ID de usuario",
	sessionEmail: "Email de sesión",
	ip: "IP",
} as const;

export class OrganizationRequestManager {
	constructor(
		private readonly projects: ProjectManager,
		private readonly issues: IssueManager,
		private readonly issueModel: Model<Issue>,
		private readonly kernelKey: symbol,
		private readonly logger: ILogger,
		private readonly config: OrganizationRequestConfig = {}
	) {}

	/**
	 * Desvincula de un usuario las solicitudes de organización que abrió (purga de cuenta).
	 * Igual que los tickets de soporte, viven en un proyecto global y no las alcanza la cascada
	 * de proyectos privados. Se conserva la solicitud —es el respaldo del alta de una
	 * organización que puede seguir existiendo— y se borran el email de sesión y la IP.
	 */
	async anonymizeRequester(kernelKey: symbol, userId: string): Promise<number> {
		if (kernelKey !== this.kernelKey) throw new Error("Acceso denegado: kernel key inválida");
		if (!userId) return 0;

		const docs = await this.issueModel
			.find({ "customFields.type": "org_creation_request", "customFields.requestedByUserId": userId }, { id: 1, description: 1 })
			.lean<{ id: string; description: unknown }[]>();

		for (const doc of docs) {
			const patch: Record<string, unknown> = {
				reporterId: "",
				updatedAt: new Date(),
				"customFields.requestedByUserId": null,
				"customFields.requestedByEmail": null,
				"customFields.requestIp": null,
			};
			if (Array.isArray(doc.description)) patch.description = redactLabeledParagraphs(doc.description as Block[], REQUESTER_LABELS);
			await this.issueModel.updateOne({ id: doc.id }, { $set: patch });
		}

		return docs.length;
	}

	async create(
		kernelKey: symbol,
		input: CreateOrganizationRequestInput,
		caller: OrganizationRequestCaller
	): Promise<OrganizationRequestIssueResponse> {
		this.#projectSlug(); // valida configuración antes de tocar la base.
		// Autogenera/reconcilia el tablero en la propia request (ver `ensureTicketBoard`).
		const project = await ensureTicketBoard({ projects: this.projects, logger: this.logger }, kernelKey, "org-requests", this.config);
		if (!project) {
			throw new ProjectManagerError(
				503,
				"ORG_REQUEST_PROJECT_UNAVAILABLE",
				"El proyecto configurado para solicitudes de organización no existe"
			);
		}

		const columnKey: CommonTicketColumnKey = ORG_REQUEST_COLUMN_KEY;

		const issue = await this.issues.createInternal(
			kernelKey,
			project,
			{
				title: `Solicitud de organización: ${input.name}`,
				description: organizationRequestBlocks(input, caller),
				category: "task",
				columnKey,
				customFields: organizationRequestCustomFields(input, caller),
			},
			caller.userId
		);

		return {
			ticketId: issue.id,
			ticketKey: issue.key,
			message: `Solicitud creada. El ID es ${issue.key}.`,
		};
	}

	#rawProjectSlug(): string {
		return this.config.organizationRequestsProjectId?.trim() || this.config.orgManagementProjectId?.trim() || "";
	}

	#projectSlug(): string {
		const slug = this.#rawProjectSlug();
		if (!slug) {
			throw new ProjectManagerError(
				503,
				"ORG_REQUEST_PROJECT_NOT_CONFIGURED",
				"Falta configurar ORG_MANAGEMENT_PROJECT_ID (slug del proyecto) para crear solicitudes de organización"
			);
		}
		return slug;
	}

	/**
	 * Ruta de app del tablero de solicitudes (proyecto global, `/default/:slug`) para
	 * enlazar notificaciones a administradores; `null` si el proyecto no está configurado.
	 */
	get appPath(): string | null {
		const slug = this.#rawProjectSlug();
		return slug ? `/default/${slug}` : null;
	}
}

function organizationRequestCustomFields(input: CreateOrganizationRequestInput, caller: OrganizationRequestCaller) {
	return {
		type: "org_creation_request",
		requestedByUserId: caller.userId,
		requestedByEmail: caller.email ?? null,
		requestIp: caller.ip,
		organizationName: input.name,
		organizationEmail: input.email,
		organizationUrl: input.url ?? null,
		socialNetworks: input.socialNetworks?.map((item) => `${item.platform}: ${item.url}`) ?? [],
	};
}

function organizationRequestBlocks(input: CreateOrganizationRequestInput, caller: OrganizationRequestCaller): Block[] {
	const blocks: Block[] = [
		{ type: "heading", level: 3, text: "Información de la organización" },
		{ type: "paragraph", text: `Nombre: ${input.name}` },
		{ type: "paragraph", text: `Email: ${input.email}` },
		{ type: "paragraph", text: `Sitio web: ${input.url || "No proporcionado"}` },
		{ type: "heading", level: 3, text: "Descripción" },
		{ type: "paragraph", text: input.description || "Sin descripción adicional" },
		{ type: "heading", level: 3, text: "Redes sociales / canales" },
	];

	if (input.socialNetworks?.length) {
		blocks.push({ type: "list", ordered: false, items: input.socialNetworks.map((item) => `${item.platform}: ${item.url}`) });
	} else {
		blocks.push({ type: "paragraph", text: "No especificadas" });
	}

	blocks.push(
		{ type: "heading", level: 3, text: "Solicitante" },
		{ type: "paragraph", text: `ID de usuario: ${caller.userId}` },
		{ type: "paragraph", text: `Email de sesión: ${caller.email || "No disponible"}` },
		{ type: "paragraph", text: `IP: ${caller.ip}` }
	);

	return blocks;
}
