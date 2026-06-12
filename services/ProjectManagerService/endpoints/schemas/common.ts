import { Type } from "@sinclair/typebox";

/**
 * Schemas TypeBox compartidos por los endpoints de ProjectManagerService.
 * Alimentan la validación de entrada (runtime) y el doc OpenAPI en `/api/docs`.
 */

/** Respuesta genérica de operación exitosa (`{ ok: true }`). */
export const OkResponse = Type.Object({ ok: Type.Boolean() });

// ── Params comunes ───────────────────────────────────────────────────────

export const IdParams = Type.Object({
	id: Type.String({ minLength: 1, description: "ID del recurso" }),
});

export const ProjectIdParams = Type.Object({
	projectId: Type.String({ minLength: 1, description: "ID del proyecto" }),
});

// ── Contenido enriquecido ───────────────────────────────────────────────────

/** Bloque de contenido enriquecido (descripciones de issues y comentarios). */
export const BlockSchema = Type.Object(
	{ type: Type.String({ description: "heading | paragraph | list | code | callout | quote | table | attachment | divider | checkbox" }) },
	{ additionalProperties: true }
);

// ── Adjuntos ───────────────────────────────────────────────────────────────

/** Adjunto (DTO público; no expone `bucket` ni `storageKey`). */
export const AttachmentDto = Type.Object({
	id: Type.String(),
	fileName: Type.String(),
	mimeType: Type.String(),
	size: Type.Integer(),
	status: Type.String({ description: "pending | ready" }),
	uploadedBy: Type.String(),
	uploadedAt: Type.Optional(Type.String({ format: "date-time" })),
	createdAt: Type.String({ format: "date-time" }),
});

// ── Tickets / solicitudes ───────────────────────────────────────────────────

/** Respuesta de creación de ticket de soporte o solicitud de organización. */
export const TicketIssueResponse = Type.Object({
	ticketId: Type.String(),
	ticketKey: Type.String({ description: "Key human-readable del issue creado" }),
	message: Type.String(),
});
