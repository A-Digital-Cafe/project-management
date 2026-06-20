import { useTranslation } from "@ui-library/utils/i18n-react";
import type { Project } from "@common/types/project-manager/Project.ts";
import type { Issue } from "@common/types/project-manager/Issue.ts";
import type { Sprint } from "@common/types/project-manager/Sprint.ts";
import type { Milestone } from "@common/types/project-manager/Milestone.ts";
import type { IssueFormState } from "./issueForm.ts";
import { UserPicker } from "./pickers/UserPicker.tsx";
import { GroupPicker } from "./pickers/GroupPicker.tsx";
import { CustomFieldsEditor } from "./pickers/CustomFieldsEditor.tsx";
import { IssueLinksEditor } from "./pickers/IssueLinksEditor.tsx";

interface Props {
	form: IssueFormState;
	onChange: (patch: Partial<IssueFormState>) => void;
	project: Project;
	sprints: Sprint[];
	milestones: Milestone[];
	issue: Issue | null;
	projectIssues: Issue[];
	canEdit: boolean;
	isNew: boolean;
}

/** Columna derecha del diálogo de issue: prioridad, ubicación, asignados, custom fields y links. */
export function IssueMetaFields({ form, onChange, project, sprints, milestones, issue, projectIssues, canEdit, isNew }: Readonly<Props>) {
	const { t } = useTranslation({ namespace: "adc-project-manager" });
	return (
		<aside className="space-y-3 lg:border-l lg:border-border lg:pl-4 min-w-0">
			<div className="grid grid-cols-3 gap-2">
				<div>
					<label className="block text-sm font-medium mb-1 text-text">{t("issues.urgency")}</label>
					<adc-input type="number" value={String(form.urgency)} onInput={(e: any) => onChange({ urgency: Number(e.target.value) })} disabled={!canEdit} />
				</div>
				<div>
					<label className="block text-sm font-medium mb-1 text-text">{t("issues.impact")}</label>
					<adc-input type="number" value={String(form.importance)} onInput={(e: any) => onChange({ importance: Number(e.target.value) })} disabled={!canEdit} />
				</div>
				<div>
					<label className="block text-sm font-medium mb-1 text-text">{t("issues.difficulty")}</label>
					<adc-input type="number" value={String(form.difficulty)} onInput={(e: any) => onChange({ difficulty: Number(e.target.value) })} disabled={!canEdit} />
				</div>
			</div>
			<div>
				<label className="block text-sm font-medium mb-1 text-text">{t("issues.column")}</label>
				<adc-combobox
					value={form.columnKey}
					clearable={false}
					options={JSON.stringify(project.kanbanColumns.map((c) => ({ label: c.name, value: c.key })))}
					onadcChange={(e: any) => onChange({ columnKey: e.detail })}
					disabled={!canEdit}
				/>
			</div>
			<div className="grid grid-cols-1 gap-2">
				<div>
					<label className="block text-sm font-medium mb-1 text-text">{t("issues.sprint")}</label>
					<adc-combobox
						value={form.sprintId}
						placeholder={t("issues.unassigned")}
						options={JSON.stringify(sprints.map((s) => ({ label: s.name, value: s.id })))}
						onadcChange={(e: any) => onChange({ sprintId: e.detail })}
						disabled={!canEdit}
					/>
				</div>
				<div>
					<label className="block text-sm font-medium mb-1 text-text">{t("issues.milestone")}</label>
					<adc-combobox
						value={form.milestoneId}
						placeholder={t("issues.unassigned")}
						options={JSON.stringify(milestones.map((m) => ({ label: m.name, value: m.id })))}
						onadcChange={(e: any) => onChange({ milestoneId: e.detail })}
						disabled={!canEdit}
					/>
				</div>
			</div>
			<UserPicker
				label={t("issues.assignees")}
				selectedIds={form.assigneeIds}
				onChange={(ids) => onChange({ assigneeIds: ids })}
				disabled={!canEdit}
				initialCache={issue?.assigneeProfiles}
			/>
			<GroupPicker
				label={t("issues.assigneeGroups")}
				selectedIds={form.assigneeGroupIds}
				orgId={project.orgId}
				onChange={(ids) => onChange({ assigneeGroupIds: ids })}
				disabled={!canEdit}
				resolvedById={issue?.assigneeGroupProfiles}
			/>
			<CustomFieldsEditor
				defs={project.customFieldDefs}
				values={form.customFields}
				onChange={(values) => onChange({ customFields: values })}
				disabled={!canEdit}
			/>
			{project.issueLinkTypes.length > 0 && (
				<div>
					<label className="block text-sm font-medium mb-1 text-text">{t("issues.links")}</label>
					<IssueLinksEditor
						linkTypes={project.issueLinkTypes}
						currentIssueId={issue?.id}
						allIssues={projectIssues}
						value={form.linkedIssues}
						onChange={(links) => onChange({ linkedIssues: links })}
						disabled={!canEdit}
					/>
				</div>
			)}
			{!isNew && canEdit && (
				<div>
					<label className="block text-sm font-medium mb-1 text-text">{t("issues.reason")}</label>
					<adc-input value={form.reason} onInput={(e: any) => onChange({ reason: e.target.value })} />
				</div>
			)}
		</aside>
	);
}
