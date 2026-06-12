import { RegisterEndpoint, type EndpointCtx } from "@services/core/EndpointManagerService/index.js";
import { ProjectManagerError } from "@common/types/custom-errors/ProjectManagerError.ts";
import type ProjectManagerService from "../index.js";
import { buildIssueResourceCtx } from "./utils/issueResourceCtx.ts";
import * as AS from "./schemas/attachments.js";
import { IdParams, OkResponse, AttachmentDto } from "./schemas/common.js";

const ATT_RATE_LIMIT = { max: 30, timeWindow: 60_000 };

interface PresignBody {
	fileName: string;
	mimeType: string;
	size: number;
	/** Si está presente, marca el adjunto para un comentario en lugar del issue. */
	forComment?: boolean;
}

export class IssueAttachmentsEndpoints {
	private static service: ProjectManagerService;
	private static kernelKey: symbol;

	static init(service: ProjectManagerService, kernelKey: symbol): void {
		IssueAttachmentsEndpoints.service ??= service;
		IssueAttachmentsEndpoints.kernelKey ??= kernelKey;
	}

	@RegisterEndpoint({
		method: "GET",
		url: "/api/pm/issues/:id/attachments",
		deferAuth: true,
		options: {
			tag: "ProjectManagerService/Attachments",
			summary: "Lista los adjuntos de un issue",
			schema: { params: IdParams, response: { 200: AS.AttachmentsListResponse } },
		},
	})
	static async list(ctx: EndpointCtx<{ id: string }>) {
		const svc = IssueAttachmentsEndpoints.service;
		const { issue, attachmentCtx } = await buildIssueResourceCtx(svc, IssueAttachmentsEndpoints.kernelKey, ctx);
		const attachments = await svc.issueAttachments.listByOwner(attachmentCtx, "pm-issue", issue.id);
		return attachments.map((a) => svc.issueAttachments.toDto(a));
	}

	@RegisterEndpoint({
		method: "POST",
		url: "/api/pm/issues/:id/attachments/presign-upload",
		deferAuth: true,
		options: {
			rateLimit: ATT_RATE_LIMIT,
			tag: "ProjectManagerService/Attachments",
			summary: "Genera una URL firmada para subir un adjunto",
			description: "Con `forComment: true` el adjunto se asocia a un comentario en vez del issue.",
			schema: { params: IdParams, body: AS.PresignBody, response: { 200: AS.PresignResponse } },
		},
	})
	static async presign(ctx: EndpointCtx<{ id: string }, PresignBody>) {
		if (!ctx.data?.fileName || !ctx.data?.mimeType || typeof ctx.data?.size !== "number") {
			throw new ProjectManagerError(400, "MISSING_FIELDS", "`fileName`, `mimeType` y `size` requeridos");
		}
		const svc = IssueAttachmentsEndpoints.service;
		const { issue, attachmentCtx } = await buildIssueResourceCtx(svc, IssueAttachmentsEndpoints.kernelKey, ctx, { requireAuth: true });
		const ownerType = ctx.data.forComment ? "pm-issue-comment" : "pm-issue";
		return svc.issueAttachments.presignUpload(attachmentCtx, {
			fileName: ctx.data.fileName,
			mimeType: ctx.data.mimeType,
			size: ctx.data.size,
			ownerType,
			ownerId: issue.id,
		});
	}

	@RegisterEndpoint({
		method: "POST",
		url: "/api/pm/issues/:id/attachments/:attachmentId/confirm",
		deferAuth: true,
		options: {
			rateLimit: ATT_RATE_LIMIT,
			tag: "ProjectManagerService/Attachments",
			summary: "Confirma la subida de un adjunto",
			schema: { params: AS.IdAttachmentParams, response: { 200: AttachmentDto } },
		},
	})
	static async confirm(ctx: EndpointCtx<{ id: string; attachmentId: string }>) {
		const svc = IssueAttachmentsEndpoints.service;
		const { attachmentCtx } = await buildIssueResourceCtx(svc, IssueAttachmentsEndpoints.kernelKey, ctx, { requireAuth: true });
		const attachment = await svc.issueAttachments.confirmUpload(attachmentCtx, ctx.params.attachmentId);
		return svc.issueAttachments.toDto(attachment);
	}

	@RegisterEndpoint({
		method: "GET",
		url: "/api/pm/issues/:id/attachments/:attachmentId/download",
		deferAuth: true,
		options: {
			tag: "ProjectManagerService/Attachments",
			summary: "Obtiene una URL firmada de descarga de un adjunto",
			schema: { params: AS.IdAttachmentParams, querystring: AS.DownloadQuery, response: { 200: AS.DownloadResponse } },
		},
	})
	static async download(ctx: EndpointCtx<{ id: string; attachmentId: string }>) {
		const svc = IssueAttachmentsEndpoints.service;
		const { attachmentCtx } = await buildIssueResourceCtx(svc, IssueAttachmentsEndpoints.kernelKey, ctx);
		const inline = ctx.query.inline === "1" || ctx.query.inline === "true";
		const ttl = ctx.query.ttl ? Number(ctx.query.ttl) : undefined;
		const result = await svc.issueAttachments.getDownloadUrl(attachmentCtx, ctx.params.attachmentId, { inline, ttl });
		return {
			url: result.url,
			expiresIn: result.expiresIn,
			attachment: svc.issueAttachments.toDto(result.attachment),
		};
	}

	@RegisterEndpoint({
		method: "DELETE",
		url: "/api/pm/issues/:id/attachments/:attachmentId",
		deferAuth: true,
		options: {
			rateLimit: ATT_RATE_LIMIT,
			tag: "ProjectManagerService/Attachments",
			summary: "Elimina un adjunto",
			schema: { params: AS.IdAttachmentParams, response: { 200: OkResponse } },
		},
	})
	static async delete(ctx: EndpointCtx<{ id: string; attachmentId: string }>) {
		const svc = IssueAttachmentsEndpoints.service;
		const { attachmentCtx } = await buildIssueResourceCtx(svc, IssueAttachmentsEndpoints.kernelKey, ctx, { requireAuth: true });
		await svc.issueAttachments.delete(attachmentCtx, ctx.params.attachmentId);
		return { ok: true };
	}
}
