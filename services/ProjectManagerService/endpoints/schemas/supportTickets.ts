import { Type } from "@sinclair/typebox";
import { AUTHORITY_DECISIONS, AUTHORITY_REQUEST_TYPES } from "../../boards.ts";

/** Schema TypeBox para el endpoint de creación de tickets de soporte. */

export const CreateSupportTicketBody = Type.Object({
	type: Type.String({
		description:
			"Tipo de ticket: complaint | suggestion | security | data | expansion | minor | authority. " +
			"`authority` sólo se acepta en `POST /api/pm/support-tickets/authority`.",
	}),
	title: Type.String({ description: "Título (5-200 caracteres)" }),
	email: Type.String({ description: "Email de contacto (validado en servidor)" }),
	description: Type.String({ description: "Descripción detallada (10-5000 caracteres)" }),
	// Campos opcionales de bug bounty (solo relevantes para type === "security")
	wantsCredit: Type.Optional(Type.Boolean({ description: "Aceptar agradecimiento público (bug bounty)" })),
	creditName: Type.Optional(Type.String({ description: "Handle/nombre para los agradecimientos públicos (máx 80)" })),
	rewardPreference: Type.Optional(
		Type.Union([Type.Literal("plus"), Type.Literal("pro")], { description: "Preferencia de recompensa del reporter" })
	),
});

/**
 * Respuesta de creación de ticket. No reusa `TicketIssueResponse` porque el serializador de fastify
 * descarta las claves que el schema no declara: sin este campo el código de revocación se perdería
 * en silencio, y es la única vez que se puede mostrar.
 */
export const SupportTicketCreateResponse = Type.Object({
	ticketId: Type.String(),
	ticketKey: Type.String({ description: "Key human-readable del issue creado" }),
	message: Type.String(),
	creditRevocationToken: Type.Optional(
		Type.String({ description: "Sólo en bug bounty con crédito aceptado: código para retirar ese consentimiento" })
	),
});

export const ModerationQueueResponse = Type.Object({
	data: Type.Array(
		Type.Object({
			ticketKey: Type.String(),
			title: Type.String(),
			createdAt: Type.String(),
			columnKey: Type.String(),
			description: Type.String({ description: "Cuerpo en texto plano; de acá sale el enlace reportado" }),
		})
	),
});

/** Clave pública del ticket (`STATUS-123`) en la ruta. */
export const TicketKeyParams = Type.Object({
	ticketKey: Type.String({ minLength: 1, description: "Clave del ticket (ej. STATUS-42)" }),
});

/**
 * Decisión sobre un requerimiento de autoridad. Todo enumerado o contador: lo que se asienta en el
 * audit log no puede llevar la carátula ni el contacto del funcionario.
 */
export const AuthorityDecisionBody = Type.Object({
	decision: Type.Union(
		AUTHORITY_DECISIONS.map((d) => Type.Literal(d)),
		{ description: "pending | complied | partial | narrowed | rejected | referred" }
	),
	requestType: Type.Optional(
		Type.Union(
			AUTHORITY_REQUEST_TYPES.map((t) => Type.Literal(t)),
			{ description: "preservation | subscriber-data | content | takedown | account-block | other" }
		)
	),
	jurisdiction: Type.Optional(Type.String({ maxLength: 40, description: "Código corto (AR, AR-CABA, US-CA). Nunca la carátula" })),
	notifiedUser: Type.Optional(Type.Boolean({ description: "Si se notificó al titular de los datos alcanzados" })),
	noticeDeferred: Type.Optional(Type.Boolean({ description: "Si la notificación quedó diferida por prohibición legal" })),
	itemsDisclosed: Type.Optional(Type.Integer({ minimum: 0, description: "Cuántos elementos se entregaron (0 = ninguno)" })),
});

/** Revocación del crédito público de un reporte de bug bounty. */
export const CreditRevocationBody = Type.Object({
	ticketKey: Type.String({ minLength: 1, description: "Clave del reporte (ej. STATUS-42)" }),
	token: Type.String({ minLength: 1, description: "Código de revocación entregado al enviar el reporte" }),
});
