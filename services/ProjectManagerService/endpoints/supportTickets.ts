import { RegisterEndpoint, type EndpointCtx } from "@services/core/EndpointManagerService/index.js";
import { ProjectManagerError } from "@common/types/custom-errors/ProjectManagerError.ts";
import { AuthorizationError } from "@common/types/custom-errors/AuthorizationError.ts";
import { AuditError } from "@common/types/custom-errors/AuditError.ts";
import { P } from "@common/types/Permissions.ts";
import type { CreateSupportTicketInput, SupportTicketType } from "@common/types/project-manager/SupportTicket.ts";
import {
	SUPPORT_TICKET_VALIDATORS,
	validateStringField,
	TICKET_TYPE_LABELS,
	BUG_BOUNTY_FIELD_CONSTRAINTS,
	ANONYMOUS_TICKET_TYPES,
} from "@common/types/project-manager/SupportTicket.ts";
import type { IAuditLogService } from "@common/types/security/AuditLog.ts";
import type { Capability } from "@common/security/Capability.ts";
import type { AuthorityDecisionInput } from "../dao/supportTickets.ts";
import { AUTHORITY_DECISIONS, AUTHORITY_REQUEST_TYPES, type AuthorityDecision, type AuthorityRequestType } from "../boards.ts";
import type ProjectManagerService from "../index.js";
import * as TS from "./schemas/supportTickets.js";
import { OkResponse } from "./schemas/common.js";

// Rate limiting: 10 tickets máximo cada 3 días por IP
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const SUPPORT_TICKET_RATE_LIMIT = { max: 5, timeWindow: THREE_DAYS_MS };
/**
 * El canal de autoridades tiene su propia ruta y su propio límite: una fiscalía entera sale por una
 * sola IP, y 5 envíos cada 3 días alcanzarían para que un oficio no entre. Se separa la ruta en vez
 * de aflojar el límite general para que nadie use la ventana ancha para spamear reclamos.
 */
const AUTHORITY_TICKET_RATE_LIMIT = { max: 30, timeWindow: THREE_DAYS_MS };
/** Un pedido de revocación fallido es un intento de adivinar un código: la ventana es angosta. */
const CREDIT_REVOCATION_RATE_LIMIT = { max: 10, timeWindow: 60 * 60 * 1000 };

/**
 * `actorUserId` es obligatorio en el audit log y la entrada de autoridades es anónima por diseño
 * (un organismo no tiene ni tiene por qué tener cuenta). Este centinela deja explícito que no hubo
 * actor autenticado, en vez de inventar uno o dejar el campo vacío y perder la entrada.
 */
const ANONYMOUS_AUTHORITY_ACTOR = "anonymous:authority-intake";

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

function normalizeAuthorityDecision(data: unknown): AuthorityDecisionInput {
	const record = (data ?? {}) as Record<string, unknown>;
	const decision = readTrimmedString(record.decision) as AuthorityDecision | undefined;
	if (!decision || !AUTHORITY_DECISIONS.includes(decision)) {
		throw new ProjectManagerError(400, "INVALID_FIELD", `\`decision\` debe ser uno de: ${AUTHORITY_DECISIONS.join(", ")}`);
	}
	const requestType = readTrimmedString(record.requestType) as AuthorityRequestType | undefined;
	if (requestType && !AUTHORITY_REQUEST_TYPES.includes(requestType)) {
		throw new ProjectManagerError(400, "INVALID_FIELD", `\`requestType\` debe ser uno de: ${AUTHORITY_REQUEST_TYPES.join(", ")}`);
	}
	const items = Number(record.itemsDisclosed ?? 0);
	return {
		decision,
		requestType: requestType ?? null,
		// Un código corto, no la carátula: lo que va acá termina en el tablero y en el audit log.
		jurisdiction: readTrimmedString(record.jurisdiction)?.slice(0, 40) ?? null,
		notifiedUser: record.notifiedUser === true,
		noticeDeferred: record.noticeDeferred === true,
		itemsDisclosed: Number.isFinite(items) && items > 0 ? Math.floor(items) : 0,
	};
}

export class SupportTicketEndpoints {
	private static service: ProjectManagerService;
	private static kernelKey: symbol;
	/** Capability del servicio, para escribir en el audit log (`audit:write`). */
	private static cap: Capability;

	static init(service: ProjectManagerService, kernelKey: symbol, cap: Capability): void {
		SupportTicketEndpoints.service ??= service;
		SupportTicketEndpoints.kernelKey ??= kernelKey;
		SupportTicketEndpoints.cap ??= cap;
	}

	/**
	 * Auditoría disponible o 503 **antes** de tocar la base: un requerimiento de autoridad sin rastro
	 * no se procesa. El pre-flight es lo único que evita crear el ticket y descubrir después que la
	 * entrada no se puede escribir.
	 */
	private static requireAudit(): IAuditLogService {
		const audit = SupportTicketEndpoints.service.getAuditWriter();
		if (!audit?.isWritable()) {
			throw new AuditError(503, "AUDIT_UNAVAILABLE", "Registro de auditoría no disponible: el requerimiento no se puede recibir");
		}
		return audit;
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
				"Requiere usuario autenticado, salvo los tickets de tipo `data` (reporte de contenido/datos de terceros) y `minor` (solicitud de quien ejerce la responsabilidad parental), que se aceptan sin sesión. Los requerimientos de autoridades (`authority`) entran por `POST /api/pm/support-tickets/authority`. Rate limit: 5 tickets por IP cada 3 días. El `email`, `title` y `description` se validan en servidor.",
			schema: { body: TS.CreateSupportTicketBody, response: { 201: TS.SupportTicketCreateResponse } },
		},
	})
	static async create(ctx: EndpointCtx<never, CreateSupportTicketInput>) {
		const input = normalizeInput(ctx.data);
		// Autoridades tiene ruta propia (límite más ancho + auditoría fail-closed). Aceptarlo también
		// acá dejaría entrar el mismo ticket sin registro y por el camino barato.
		if (input.type === "authority") {
			throw new ProjectManagerError(400, "INVALID_FIELD", "Los requerimientos de autoridades se envían a /api/pm/support-tickets/authority");
		}
		if (!ANONYMOUS_TICKET_TYPES.has(input.type) && !ctx.user?.id)
			throw new AuthorizationError("Debes iniciar sesión para crear un ticket de soporte", "NO_TOKEN");

		return SupportTicketEndpoints.service.supportTickets.create(SupportTicketEndpoints.kernelKey, input, {
			userId: ctx.user?.id ?? null,
			email: ctx.user?.email,
		});
	}

	/**
	 * Entrada de requerimientos de autoridades públicas (judiciales, administrativas o regulatorias).
	 * Sin sesión: un organismo no tiene cuenta. Ruta separada del resto de los tickets por dos
	 * motivos que no conviven en un solo endpoint: el límite por IP tiene que tolerar a una fiscalía
	 * detrás de un NAT, y la recepción es **fail-closed** respecto del audit log.
	 */
	@RegisterEndpoint({
		method: "POST",
		url: "/api/pm/support-tickets/authority",
		options: {
			successStatus: 201,
			rateLimit: AUTHORITY_TICKET_RATE_LIMIT,
			tag: "ProjectManagerService/SupportTickets",
			summary: "Recibe un requerimiento de una autoridad pública",
			description:
				"Público (sin sesión). Rate limit: 30 envíos por IP cada 3 días. Deja una entrada `authority.request-received` en el registro de auditoría; si el registro no está disponible responde 503 y NO recibe el requerimiento. Un pedido informal, sin instrumento adjunto, no se procesa.",
			schema: { body: TS.CreateSupportTicketBody, response: { 201: TS.SupportTicketCreateResponse } },
		},
	})
	static async createAuthority(ctx: EndpointCtx<never, CreateSupportTicketInput>) {
		const input = normalizeInput(ctx.data);
		if (input.type !== "authority") {
			throw new ProjectManagerError(400, "INVALID_FIELD", "Esta ruta sólo recibe tickets de tipo `authority`");
		}
		const audit = SupportTicketEndpoints.requireAudit();

		const result = await SupportTicketEndpoints.service.supportTickets.create(SupportTicketEndpoints.kernelKey, input, {
			userId: ctx.user?.id ?? null,
			email: ctx.user?.email,
		});

		// Sólo ids y flags: el saneador del audit log descarta cualquier string con "@" o con forma
		// de IPv4, así que el contacto del funcionario y la carátula no entran acá ni por error.
		await audit.recordStrict(SupportTicketEndpoints.cap, {
			action: "authority.request-received",
			actorUserId: ctx.user?.id || ANONYMOUS_AUTHORITY_ACTOR,
			targetResource: "pm:support-ticket",
			context: { ticketKey: result.ticketKey, authenticated: !!ctx.user?.id },
		});

		return result;
	}

	/**
	 * Asienta la decisión sobre un requerimiento de autoridad. El rastro va primero: si la escritura
	 * del audit log falla, no hay decisión. Al revés (tablero primero) una caída dejaría un
	 * requerimiento resuelto sin registro, que es exactamente lo que no puede pasar.
	 */
	@RegisterEndpoint({
		method: "POST",
		url: "/api/pm/support-tickets/:ticketKey/authority-decision",
		permissions: [P.PROJECT_MANAGER.ISSUES.UPDATE],
		options: {
			tag: "ProjectManagerService/SupportTickets",
			summary: "Registra la decisión sobre un requerimiento de autoridad",
			description:
				"Deja una entrada `authority.request-decided` en el registro de auditoría y refleja la decisión en el ticket. Sólo enumerados y contadores: la carátula y los datos del funcionario firmante viven en el ticket, no en el registro.",
			schema: { params: TS.TicketKeyParams, body: TS.AuthorityDecisionBody, response: { 200: OkResponse } },
		},
	})
	static async authorityDecision(ctx: EndpointCtx<{ ticketKey: string }, unknown>) {
		const input = normalizeAuthorityDecision(ctx.data);
		const audit = SupportTicketEndpoints.requireAudit();
		const { ticketKey } = ctx.params;

		await audit.recordStrict(SupportTicketEndpoints.cap, {
			action: "authority.request-decided",
			actorUserId: ctx.user!.id,
			targetResource: "pm:support-ticket",
			context: {
				ticketKey,
				decision: input.decision,
				requestType: input.requestType,
				jurisdiction: input.jurisdiction,
				notifiedUser: input.notifiedUser,
				noticeDeferred: input.noticeDeferred,
				itemsDisclosed: input.itemsDisclosed,
			},
		});

		const applied = await SupportTicketEndpoints.service.supportTickets.recordAuthorityDecision(
			SupportTicketEndpoints.kernelKey,
			ticketKey,
			input
		);
		if (!applied) throw new ProjectManagerError(404, "ISSUE_NOT_FOUND", `No hay un ticket de autoridades con clave ${ticketKey}`);
		return { ok: true };
	}

	/**
	 * Retira el agradecimiento público de un reporte de bug bounty. PÚBLICO (sin sesión): quien
	 * reportó puede no tener cuenta, así que la prueba es el código que se le mostró al enviar.
	 *
	 * Retirar el consentimiento tiene que ser tan fácil como darlo, pero el hallazgo NO se borra: la
	 * entrada sigue en el log con su `descriptionHash`, sólo deja de estar firmada.
	 */
	@RegisterEndpoint({
		method: "POST",
		url: "/api/pm/bug-bounty/credit-revocation",
		options: {
			rateLimit: CREDIT_REVOCATION_RATE_LIMIT,
			tag: "ProjectManagerService/SupportTickets",
			summary: "Retira el crédito público de un reporte de bug bounty",
			description:
				"Público. Requiere el código de revocación entregado al enviar el reporte. El hallazgo, su hash y su descripción divulgada se conservan: sólo se borra el handle. Si el código se perdió, pedirlo por un ticket de soporte citando la clave del reporte.",
			schema: { body: TS.CreditRevocationBody, response: { 200: OkResponse } },
		},
	})
	static async revokeCredit(ctx: EndpointCtx<never, { ticketKey?: string; token?: string }>) {
		const ticketKey = requireTrimmedString(ctx.data?.ticketKey, "ticketKey");
		const token = requireTrimmedString(ctx.data?.token, "token");
		const revoked = await SupportTicketEndpoints.service.supportTickets.revokeBugBountyCredit(
			SupportTicketEndpoints.kernelKey,
			ticketKey,
			token
		);
		// Una respuesta distinta por "ticket inexistente" y por "código inválido" convertiría el
		// endpoint en un oráculo de claves de ticket: se responde igual en ambos casos.
		if (!revoked) throw new AuthorizationError("La clave o el código de revocación no son válidos", "FORBIDDEN");
		return { ok: true };
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
