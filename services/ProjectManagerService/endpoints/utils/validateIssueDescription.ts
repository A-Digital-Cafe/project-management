import type ProjectManagerService from "../../index.js";
import type { IssueAttachmentEndpointCtx } from "../../permissions/issueAttachments.ts";
import type { Block } from "@common/ADC/types/learning.ts";
import { sanitizeBlocks, extractAttachmentIdsFromBlocks } from "@common/utils/blocks/sanitize.ts";
import { assertOwnedAttachments } from "@common/utils/blocks/attachment-ownership.ts";
import { ProjectManagerError } from "@common/types/custom-errors/ProjectManagerError.ts";
import { ISSUE_DESCRIPTION_MAX_BLOCKS } from "../../dao/issues.ts";

/** Máximo de adjuntos referenciables desde una descripción de issue. */
export const ISSUE_DESCRIPTION_MAX_ATTACHMENTS = 10;

/**
 * Sanitiza blocks de descripción de issue y valida que los adjuntos referenciados
 * existan, sean accesibles al caller y le pertenezcan (uploader). Mantiene paridad
 * de seguridad con `CommentsManager.#validateAttachments` para que las reglas
 * org/permission/uploader coincidan entre comments y descripciones.
 */
export async function validateAndSanitizeIssueDescription(
	service: ProjectManagerService,
	attachmentCtx: IssueAttachmentEndpointCtx,
	rawBlocks: unknown
): Promise<Block[]> {
	const blocks = sanitizeBlocks(rawBlocks, { maxBlocks: ISSUE_DESCRIPTION_MAX_BLOCKS });
	const attachmentIds = extractAttachmentIdsFromBlocks(blocks);
	if (!attachmentIds.length) return blocks;
	if (attachmentIds.length > ISSUE_DESCRIPTION_MAX_ATTACHMENTS) {
		throw new ProjectManagerError(
			400,
			"ISSUE_DESCRIPTION_TOO_MANY_ATTACHMENTS",
			`Máximo ${ISSUE_DESCRIPTION_MAX_ATTACHMENTS} adjuntos por descripción`
		);
	}
	const found = await service.issueAttachments.getMany(attachmentCtx as any, attachmentIds);
	// Regla compartida: existencia + uploader == autor (ver @common/utils/blocks/attachment-ownership)
	assertOwnedAttachments({ requestedIds: attachmentIds, found, userId: attachmentCtx.userId, errorPrefix: "ISSUE_DESCRIPTION" });
	return blocks;
}
