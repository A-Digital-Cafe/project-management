import { RegisterEndpoint, type EndpointCtx } from "@services/core/EndpointManagerService/index.js";
import { ProjectManagerError } from "@common/types/custom-errors/ProjectManagerError.ts";
import { AuthorizationError } from "@common/types/custom-errors/AuthorizationError.ts";
import { P } from "@common/types/Permissions.ts";
import type { CreateSupportTicketInput, SupportTicketType } from "@common/types/project-manager/SupportTicket.ts";
import {
	SUPPORT_TICKET_VALIDATORS,
	validateStringField,
	TICKET_TYPE_LABELS,
	BUG_BOUNTY_FIELD_CONSTRAINTS,
	ANONYMOUS_TICKET_TYPES,
} from "@common/types/project-manager/SupportTicket.ts";
import type ProjectManagerService from "../index.js";
import * as TS from "./schemas/supportTickets.js";
import { TicketIssueResponse } from "./schemas/common.js";

// Rate limiting: 10 tickets máximo cada 3 días por IP
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const SUPPORT_TICKET_RATE_LIMIT = { max: 5, timeWindow: THREE_DAYS_MS };

// Extract valid types from TICKET_TYPE_LABELS to avoid duplication
const VALID_TICKET_TYPES = Object.keys(TICKET_TYPE_LABELS) as SupportTicketType[];

function readTrimmedString(value: unknown): string | undefined {
	return typeof value === "string" ? value.trim() : undefined;
}

function requireTrimmedString(value: unknown, field: string): string {
	const trimmed = readTrimmedString(value);
	if (!trimmed) throw new ProjectManagerError(400, "MISSING_FIELDS", `\`${field}\` es requerido`);
	return trimmed;
}

function normalizeEmail(value: unknown): string {
	const email = requireTrimmedString(value, "email").toLowerCase();
	const validation = validateStringField(email, SUPPORT_TICKET_VALIDATORS.email);

	if (!validation.valid) {
		// Return error code for frontend i18n translation (format: field:code)
		throw new ProjectManagerError(400, "INVALID_FIELD", `email:${validation.reason}`);
	}
	return email;
}

function validateTitle(value: unknown): string {
	const title = requireTrimmedString(value, "title");
	const validation = validateStringField(title, SUPPORT_TICKET_VALIDATORS.title);

	if (!validation.valid) {
		// Return error code for frontend i18n translation (format: field:code)
		throw new ProjectManagerError(400, "INVALID_FIELD", `title:${validation.reason}`);
	}
	return title;
}

function validateDescription(value: unknown): string {
	const description = requireTrimmedString(value, "description");
	const validation = validateStringField(description, SUPPORT_TICKET_VALIDATORS.description);

	if (!validation.valid) {
		// Return error code for frontend i18n translation (format: field:code)
		throw new ProjectManagerError(400, "INVALID_FIELD", `description:${validation.reason}`);
	}
	return description;
}

function validateTicketType(value: unknown): SupportTicketType {
	const type = readTrimmedString(value);
	if (!type || !VALID_TICKET_TYPES.includes(type as SupportTicketType)) {
		throw new ProjectManagerError(400, "INVALID_FIELD", `\`type\` debe ser uno de: ${VALID_TICKET_TYPES.join(", ")}`);
	}
	return type as SupportTicketType;
}

function normalizeRewardPreference(value: unknown): "plus" | "pro" | undefined {
	const v = readTrimmedString(value);
	return v === "plus" || v === "pro" ? v : undefined;
}

function normalizeCreditName(value: unknown): string | undefined {
	const name = readTrimmedString(value);
	if (!name) return undefined;
	return name.slice(0, BUG_BOUNTY_FIELD_CONSTRAINTS.creditName.max);
}

function normalizeInput(data: unknown): CreateSupportTicketInput {
	const record = (data ?? {}) as Record<string, unknown>;

	const type = validateTicketType(record.type);
	const title = validateTitle(record.title);
	const description = validateDescription(record.description);

	const base: CreateSupportTicketInput = {
		type,
		title,
		email: normalizeEmail(record.email),
		description,
	};

	// Campos de bug bounty solo se honran para tickets de seguridad.
	if (type === "security") {
		base.wantsCredit = record.wantsCredit === true;
		base.creditName = base.wantsCredit ? normalizeCreditName(record.creditName) : undefined;
		base.rewardPreference = normalizeRewardPreference(record.rewardPreference);
	}

	return base;
}

export class SupportTicketEndpoints {
	private static service: ProjectManagerService;
	private static kernelKey: symbol;

	static init(service: ProjectManagerService, kernelKey: symbol): void {
		SupportTicketEndpoints.service ??= service;
		SupportTicketEndpoints.kernelKey ??= kernelKey;
	}

	/**
	 * Crea un ticket de soporte.
	 *
	 * Requiere sesión salvo los tipos de `ANONYMOUS_TICKET_TYPES`, que los documentos legales
	 * ofrecen a **cualquier persona**, tenga cuenta o no (reportar contenido ajeno, responsabilidad
	 * parental sobre un menor). El rate limit por IP aplica a ambos casos.
	 *
	 * Registra la información del reportante:
	 * - userId: ID del usuario autenticado (null en tickets anónimos)
	 * - email: Email del usuario autenticado (el de contacto viaja en el body)
	 * - ip: IP del cliente para análisis de patrón
	 *
	 * @returns {SupportTicketIssueResponse} ID y clave del ticket creado
	 */
	@RegisterEndpoint({
		method: "POST",
		url: "/api/pm/support-tickets",
		options: {
			successStatus: 201,
			rateLimit: SUPPORT_TICKET_RATE_LIMIT,
			tag: "ProjectManagerService/SupportTickets",
			summary: "Crea un ticket de soporte",
			description:
				"Requiere usuario autenticado, salvo los tickets de tipo `data` (reporte de contenido/datos de terceros) y `minor` (solicitud de quien ejerce la responsabilidad parental), que se aceptan sin sesión. Rate limit: 5 tickets por IP cada 3 días. El `email`, `title` y `description` se validan en servidor.",
			schema: { body: TS.CreateSupportTicketBody, response: { 201: TicketIssueResponse } },
		},
	})
	static async create(ctx: EndpointCtx<never, CreateSupportTicketInput>) {
		const input = normalizeInput(ctx.data);
		if (!ANONYMOUS_TICKET_TYPES.has(input.type) && !ctx.user?.id)
			throw new AuthorizationError("Debes iniciar sesión para crear un ticket de soporte", "NO_TOKEN");

		return SupportTicketEndpoints.service.supportTickets.create(SupportTicketEndpoints.kernelKey, input, {
			userId: ctx.user?.id ?? null,
			email: ctx.user?.email,
		});
	}

	/**
	 * Log público de transparencia del Bug Bounty Program. PÚBLICO (sin auth):
	 * expone siempre id de ticket, fecha/hora, hash SHA-256 de la descripción,
	 * estado y severidad. La descripción original aparece solo si el ticket está
	 * resuelto y el reporter pidió divulgación (y verifica contra el hash); el
	 * handle de crédito exige además que haya pedido crédito.
	 */
	@RegisterEndpoint({
		method: "GET",
		url: "/api/pm/bug-bounty/public",
		options: {
			// TTL corto: el log lo curan los admins (estado/severidad/descripción) y
			// debe reflejar cambios casi en vivo. No hay invalidación por tag (el
			// `cache` solo emite Cache-Control), así que la frescura se controla acá.
			cache: { maxAge: 15, staleWhileRevalidate: 30, scope: "public" },
			tag: "ProjectManagerService/SupportTickets",
			summary: "Log público de transparencia del bug bounty",
			description:
				"Público. Lista id, fecha/hora, hash, estado y severidad. La descripción del reporte solo se incluye si el ticket está resuelto y el reporter consintió divulgarlo; el handle de crédito requiere además su consentimiento de atribución.",
		},
	})
	static async publicBugBounty(_ctx: EndpointCtx) {
		const entries = await SupportTicketEndpoints.service.supportTickets.listPublicBugBounty(SupportTicketEndpoints.kernelKey);
		return { data: entries };
	}

	/**
	 * Cola de reportes de contenido (`data`) abiertos, que consume el panel de moderación de Drive.
	 * Sin esto había que ir al tablero, copiar el enlace a mano y volver: una cola que se opera a
	 * mano es una cola que se atiende tarde.
	 *
	 * Va gateado por `drive:moderate` y no por un permiso del PM a propósito: quien
	 * modera contenido necesita ver estos reportes, y no tiene por qué poder leer el
	 * resto de los tickets ni el tablero entero.
	 */
	@RegisterEndpoint({
		method: "GET",
		url: "/api/pm/support-tickets/moderation-queue",
		permissions: [P.DRIVE.MODERATE.EXECUTE],
		options: {
			tag: "ProjectManagerService/SupportTickets",
			summary: "Reportes de contenido abiertos, para la cola de moderación",
			description: "Sólo tickets de tipo `data` en columnas no resueltas. No incluye el email de quien reportó.",
			schema: { response: { 200: TS.ModerationQueueResponse } },
		},
	})
	static async moderationQueue(_ctx: EndpointCtx) {
		const data = await SupportTicketEndpoints.service.supportTickets.listOpenByType(SupportTicketEndpoints.kernelKey, "data");
		return { data };
	}
}
