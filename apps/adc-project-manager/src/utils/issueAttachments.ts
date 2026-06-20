import type { Block } from "@common/ADC/types/learning.ts";
import { pmApi } from "./pm-api.ts";

/** Recolecta los `attachmentId` únicos referenciados por bloques de tipo `attachment`. */
export function collectAttachmentIds(...groups: Block[][]): string[] {
	const ids = new Set<string>();
	for (const blocks of groups) {
		for (const b of blocks) {
			if (b && typeof b === "object" && (b as { type?: string }).type === "attachment") {
				const aid = (b as { attachmentId?: string }).attachmentId;
				if (aid) ids.add(aid);
			}
		}
	}
	return [...ids];
}

/**
 * Sube un archivo como adjunto de un issue (presign → PUT → confirm → URL) y
 * devuelve el bloque `attachment` listo para insertar en la descripción junto a
 * su `attachmentId` y URL inline. Devuelve `null` si algún paso falla.
 */
export async function uploadIssueAttachmentBlock(
	issueId: string,
	kind: "image" | "file",
	file: File
): Promise<{ block: Block; attachmentId: string; url?: string } | null> {
	const presignRes = await pmApi.presignIssueAttachment(issueId, {
		fileName: file.name,
		mimeType: file.type || "application/octet-stream",
		size: file.size,
		forComment: false,
	});
	if (!presignRes.success || !presignRes.data) return null;

	const presign = presignRes.data;
	const putRes = await fetch(presign.uploadUrl, { method: "PUT", body: file, headers: presign.headers });
	if (!putRes.ok) return null;

	const confirm = await pmApi.confirmIssueAttachment(issueId, presign.attachmentId);
	if (!confirm.success || !confirm.data) return null;

	const att = confirm.data;
	const dl = await pmApi.getIssueAttachmentDownloadUrl(issueId, att.id, { inline: true });
	const block: Block = {
		type: "attachment",
		kind,
		attachmentId: att.id,
		fileName: att.fileName,
		mimeType: att.mimeType,
		size: att.size,
	};
	return { block, attachmentId: att.id, url: dl.success && dl.data?.url ? dl.data.url : undefined };
}
