import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "@ui-library/utils/i18n-react";
import type { Permission } from "@common/types/identity/Permission.ts";
import type { Project } from "@common/types/project-manager/Project.ts";
import type { Issue, UrgencyImportance, Difficulty } from "@common/types/project-manager/Issue.ts";
import type { Sprint } from "@common/types/project-manager/Sprint.ts";
import type { Milestone } from "@common/types/project-manager/Milestone.ts";
import type { TransitionCommentSubmitDetail } from "./TransitionCommentModal.tsx";
import { TransitionCommentModal } from "./TransitionCommentModal.tsx";
import { pmApi } from "../utils/pm-api.ts";
import { useIssueMover } from "../hooks/useIssueMover.ts";
import { useIssueDescription } from "../hooks/useIssueDescription.ts";
import { canUpdateIssue, canWriteProjectResource, Scope, type CallerCtx } from "../utils/permissions.ts";
import { type IssueFormState, initialIssueForm } from "./issueForm.ts";
import { IssueDescriptionEditor } from "./IssueDescriptionEditor.tsx";
import { IssueMetaFields } from "./IssueMetaFields.tsx";
import { IssueActivityTabs } from "./IssueActivityTabs.tsx";

interface Props {
	project: Project;
	issue: Issue | null;
	perms: Permission[];
	caller?: CallerCtx;
	sprints?: Sprint[];
	milestones?: Milestone[];
	onClose: () => void;
	onSaved: () => void | Promise<void>;
}

function toU(n: number): UrgencyImportance {
	const v = Math.max(0, Math.min(4, Math.round(n)));
	return v as UrgencyImportance;
}
function toD(n: number): Difficulty {
	if (!Number.isFinite(n) || n <= 0) return null;
	const v = Math.max(1, Math.min(5, Math.round(n)));
	return v as Difficulty;
}

export function IssueDialog({ project, issue, perms, caller, sprints = [], milestones = [], onClose, onSaved }: Readonly<Props>) {
	const { t } = useTranslation({ namespace: "adc-project-manager" });
	const isNew = !issue;
	const [form, setForm] = useState<IssueFormState>(() => initialIssueForm(issue, project));
	const [saving, setSaving] = useState(false);
	const [projectIssues, setProjectIssues] = useState<Issue[]>([]);
	const patch = useCallback((p: Partial<IssueFormState>) => setForm((prev) => ({ ...prev, ...p })), []);

	const canEdit = isNew ? canWriteProjectResource(perms, Scope.ISSUES, project, caller) : canUpdateIssue(perms, project, issue, caller);
	const desc = useIssueDescription({ issue, canEdit, onSaved, setSaving });

	const mover = useIssueMover({
		project,
		onSuccess: async () => {
			await onSaved();
		},
	});

	const modalRef = useCallback(
		(el: HTMLElement | null) => {
			if (el) el.addEventListener("adcClose", onClose);
		},
		[onClose]
	);

	useEffect(() => {
		if (project.issueLinkTypes.length === 0) return;
		pmApi.listIssues(project.id).then((r) => {
			if (r.success && r.data) setProjectIssues(r.data.issues);
		});
	}, [project.id, project.issueLinkTypes.length]);

	const save = async () => {
		setSaving(true);
		const priority = { urgency: toU(form.urgency), importance: toU(form.importance), difficulty: toD(form.difficulty) };
		const base = {
			title: form.title,
			description: desc.description,
			sprintId: form.sprintId || undefined,
			milestoneId: form.milestoneId || undefined,
			priority,
			assigneeIds: form.assigneeIds,
			assigneeGroupIds: form.assigneeGroupIds,
			customFields: form.customFields,
			linkedIssues: form.linkedIssues,
		};
		if (isNew) {
			await pmApi.createIssue(project.id, { ...base, columnKey: form.columnKey });
			setSaving(false);
			await onSaved();
			return;
		}
		if (!issue) return;

		const columnChanged = form.columnKey !== issue.columnKey;
		// El cambio de columna pasa por el mover para exigir comentario en la
		// transición final si el proyecto lo requiere; el resto se actualiza directo.
		await pmApi.updateIssue(issue.id, { ...base, columnKey: columnChanged ? issue.columnKey : form.columnKey, reason: form.reason || undefined });
		if (columnChanged) {
			await mover.requestMove(issue.id, issue.columnKey, form.columnKey, form.reason || undefined);
			if (mover.pendingMove) {
				// El modal de comentario se abrió; onSaved se disparará tras enviarlo.
				setSaving(false);
				return;
			}
		}
		setSaving(false);
		await onSaved();
	};

	return (
		<adc-modal ref={modalRef} open modalTitle={isNew ? t("issues.newIssue") : `${issue?.key} · ${t("common.edit")}`} size="xl">
			<div className="p-4 space-y-4">
				<div>
					<label className="block text-sm font-medium mb-1 text-text">{t("issues.issueTitle")}</label>
					<adc-input value={form.title} onInput={(e: any) => patch({ title: e.target.value })} disabled={!canEdit} />
				</div>

				{/* Cuerpo: descripción 70% / metadatos 30% */}
				<div className="grid grid-cols-1 lg:grid-cols-[7fr_3fr] gap-4">
					<IssueDescriptionEditor desc={desc} canEdit={canEdit} />
					<IssueMetaFields
						form={form}
						onChange={patch}
						project={project}
						sprints={sprints}
						milestones={milestones}
						issue={issue}
						projectIssues={projectIssues}
						canEdit={canEdit}
						isNew={isNew}
					/>
				</div>

				{canEdit && (
					<div className="flex gap-2 justify-end pt-2 border-t border-text/15">
						<adc-button variant="primary" onClick={save} disabled={saving || !form.title}>
							{saving ? t("common.saving") : t("common.save")}
						</adc-button>
					</div>
				)}

				{!isNew && issue && <IssueActivityTabs issueId={issue.id} caller={caller} />}
			</div>
			<TransitionCommentModal
				open={!!mover.pendingMove}
				submitting={mover.moving}
				fromColumn={mover.pendingMove ? project.kanbanColumns.find((c) => c.key === mover.pendingMove?.fromColumn)?.name : undefined}
				toColumn={mover.pendingMove ? project.kanbanColumns.find((c) => c.key === mover.pendingMove?.toColumn)?.name : undefined}
				onCancel={() => mover.cancelMove()}
				onSubmit={(detail: TransitionCommentSubmitDetail) => {
					void mover.confirmMoveWithComment(detail);
				}}
			/>
		</adc-modal>
	);
}
