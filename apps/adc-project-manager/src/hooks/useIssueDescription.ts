import { useState, useEffect, useMemo } from "react";
import type { Issue } from "@common/types/project-manager/Issue.ts";
import type { Block } from "@common/ADC/types/learning.ts";
import { pmApi } from "../utils/pm-api.ts";
import { collectAttachmentIds, uploadIssueAttachmentBlock } from "../utils/issueAttachments.ts";

type BlocksFormDetail = { blocks?: Block[]; attachmentIds: string[] };

interface Options {
	issue: Issue | null;
	canEdit: boolean;
	onSaved: () => void | Promise<void>;
	setSaving: (saving: boolean) => void;
}

export interface IssueDescriptionController {
	description: Block[];
	savedDescription: Block[];
	editing: boolean;
	hasUnsavedDraft: boolean;
	attachmentIds: string[];
	attachmentUrls: Record<string, string>;
	resumeDraft: () => void;
	startEditing: () => void;
	cancel: () => void;
	submit: (detail: BlocksFormDetail) => Promise<void>;
	draftChange: (detail: BlocksFormDetail) => void;
	requestAttachment: (kind: "image" | "file") => void;
}

const initialBlocks = (issue: Issue | null): Block[] => (Array.isArray(issue?.description) ? issue.description : []);

/**
 * Estado y acciones del bloque de descripción de un issue: modo edición vs
 * render, draft autosalvado con banner "cambios sin guardar", y resolución de
 * URLs de adjuntos referenciados. Para issues nuevos arranca en edición y sin
 * persistencia de draft (no hay `issue` aún).
 */
export function useIssueDescription({ issue, canEdit, onSaved, setSaving }: Options): IssueDescriptionController {
	const [description, setDescription] = useState<Block[]>(() => initialBlocks(issue));
	const [savedDescription, setSavedDescription] = useState<Block[]>(() => initialBlocks(issue));
	const [editing, setEditing] = useState<boolean>(!issue);
	const [hasUnsavedDraft, setHasUnsavedDraft] = useState(false);
	const [draftDescription, setDraftDescription] = useState<Block[] | null>(null);
	const [draftAttachmentIds, setDraftAttachmentIds] = useState<string[]>([]);
	const [attachmentIds, setAttachmentIds] = useState<string[]>([]);
	const [attachmentUrls, setAttachmentUrls] = useState<Record<string, string>>({});

	// Cargar el draft de descripción al abrir un issue existente editable. No se
	// aplica automáticamente: se guarda aparte y se muestra un banner clickeable.
	useEffect(() => {
		if (!issue || !canEdit) return;
		let cancelled = false;
		(async () => {
			const r = await pmApi.getIssueDescriptionDraft(issue.id).catch(() => null);
			if (cancelled) return;
			if (r?.success && r.data?.draft) {
				setDraftDescription(r.data.draft.blocks ?? []);
				setDraftAttachmentIds(r.data.draft.attachmentIds ?? []);
				setHasUnsavedDraft(true);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [issue, canEdit]);

	const attachmentIdsToResolve = useMemo(
		() => collectAttachmentIds(savedDescription, description, draftDescription ?? []),
		[savedDescription, description, draftDescription]
	);

	// Resolver URLs (inline) de los adjuntos referenciados que aún no tengamos.
	useEffect(() => {
		if (!issue) return;
		const missing = attachmentIdsToResolve.filter((id) => !attachmentUrls[id]);
		if (missing.length === 0) return;
		let cancelled = false;
		(async () => {
			const updates: Record<string, string> = {};
			for (const id of missing) {
				const r = await pmApi.getIssueAttachmentDownloadUrl(issue.id, id, { inline: true });
				if (r.success && r.data?.url) updates[id] = r.data.url;
			}
			if (!cancelled && Object.keys(updates).length) setAttachmentUrls((prev) => ({ ...prev, ...updates }));
		})();
		return () => {
			cancelled = true;
		};
	}, [issue, attachmentIdsToResolve, attachmentUrls]);

	const resumeDraft = () => {
		if (draftDescription) {
			setDescription(draftDescription);
			setAttachmentIds(draftAttachmentIds);
		}
		setEditing(true);
	};

	const startEditing = () => {
		if (!canEdit) return;
		// El buffer arranca con lo guardado.
		setDescription(savedDescription);
		setEditing(true);
	};

	const cancel = () => {
		// Descarta el draft (local + backend) y vuelve al render con lo guardado.
		setDescription(savedDescription);
		setDraftDescription(null);
		setDraftAttachmentIds([]);
		setHasUnsavedDraft(false);
		setEditing(false);
		if (issue) pmApi.deleteIssueDescriptionDraft(issue.id);
	};

	const submit = async (detail: BlocksFormDetail) => {
		const nextBlocks = detail.blocks ?? [];
		if (issue) {
			setSaving(true);
			const r = await pmApi.updateIssue(issue.id, { description: nextBlocks });
			setSaving(false);
			if (!r.success) return;
		}
		setSavedDescription(nextBlocks);
		setDescription(nextBlocks);
		setAttachmentIds(detail.attachmentIds);
		setDraftDescription(null);
		setHasUnsavedDraft(false);
		setEditing(false);
		if (issue) {
			pmApi.deleteIssueDescriptionDraft(issue.id);
			await onSaved();
		}
	};

	const draftChange = (detail: BlocksFormDetail) => {
		const nextBlocks = detail.blocks ?? [];
		setDescription(nextBlocks);
		setAttachmentIds(detail.attachmentIds);
		if (!issue) return;
		if (nextBlocks.length === 0 && detail.attachmentIds.length === 0) {
			setHasUnsavedDraft(false);
			setDraftDescription(null);
			pmApi.deleteIssueDescriptionDraft(issue.id);
		} else {
			setHasUnsavedDraft(true);
			setDraftDescription(nextBlocks);
			setDraftAttachmentIds(detail.attachmentIds);
			pmApi.saveIssueDescriptionDraft(issue.id, { blocks: nextBlocks, attachmentIds: detail.attachmentIds });
		}
	};

	const requestAttachment = (kind: "image" | "file") => {
		if (!issue) return;
		const issueId = issue.id;
		const input = globalThis.document.createElement("input");
		input.type = "file";
		if (kind === "image") input.accept = "image/*";
		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file) return;
			const res = await uploadIssueAttachmentBlock(issueId, kind, file);
			if (!res) return;
			if (res.url) setAttachmentUrls((prev) => ({ ...prev, [res.attachmentId]: res.url as string }));
			setDescription((prev) => [...prev, res.block]);
			setAttachmentIds((prev) => [...prev, res.attachmentId]);
		};
		input.click();
	};

	return {
		description,
		savedDescription,
		editing,
		hasUnsavedDraft,
		attachmentIds,
		attachmentUrls,
		resumeDraft,
		startEditing,
		cancel,
		submit,
		draftChange,
		requestAttachment,
	};
}
