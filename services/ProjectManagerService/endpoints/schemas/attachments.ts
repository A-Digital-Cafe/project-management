import { Type } from "@sinclair/typebox";
import { AttachmentDto } from "./common.js";

/** Schemas TypeBox para los endpoints de adjuntos de issues. */

export const IdAttachmentParams = Type.Object({
	id: Type.String({ minLength: 1, description: "ID del issue" }),
	attachmentId: Type.String({ minLength: 1, description: "ID del adjunto" }),
});

export const DownloadQuery = Type.Object({
	inline: Type.Optional(Type.String({ description: '"1" / "true" para servir inline (Content-Disposition)' })),
	ttl: Type.Optional(Type.String({ description: "TTL (segundos) de la URL firmada" })),
});

export const PresignBody = Type.Object({
	fileName: Type.String({ minLength: 1 }),
	mimeType: Type.String({ minLength: 1 }),
	size: Type.Number({ description: "Tamaño en bytes" }),
	forComment: Type.Optional(Type.Boolean({ description: "Marca el adjunto para un comentario en vez del issue" })),
});

// ── Responses ──────────────────────────────────────────────────────────────

export const AttachmentsListResponse = Type.Array(AttachmentDto);

export const PresignResponse = Type.Object({
	attachmentId: Type.String(),
	uploadUrl: Type.String({ description: "URL firmada para subir el archivo (PUT)" }),
	key: Type.String(),
	bucket: Type.String(),
	headers: Type.Record(Type.String(), Type.String(), { description: "Cabeceras requeridas en el PUT" }),
	expiresAt: Type.String({ format: "date-time" }),
});

export const DownloadResponse = Type.Object({
	url: Type.String({ description: "URL firmada de descarga" }),
	expiresIn: Type.Integer({ description: "Segundos hasta expiración" }),
	attachment: AttachmentDto,
});
