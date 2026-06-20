import type { Project } from "@common/types/project-manager/Project.ts";
import type { Issue } from "@common/types/project-manager/Issue.ts";
import type { CustomFieldValue } from "@common/types/project-manager/CustomField.ts";
import type { IssueLink } from "@common/types/project-manager/IssueLink.ts";

/** Estado editable del formulario de un issue (la descripción se gestiona aparte). */
export interface IssueFormState {
	title: string;
	columnKey: string;
	sprintId: string;
	milestoneId: string;
	urgency: number;
	importance: number;
	difficulty: number;
	reason: string;
	assigneeIds: string[];
	assigneeGroupIds: string[];
	customFields: Record<string, CustomFieldValue>;
	linkedIssues: IssueLink[];
}

/** Construye el estado inicial del formulario a partir del issue (o vacío si es nuevo). */
export function initialIssueForm(issue: Issue | null, project: Project): IssueFormState {
	const defaultColumn = project.kanbanColumns.find((c) => c.isAuto)?.key ?? project.kanbanColumns[0]?.key ?? "todo";
	return {
		title: issue?.title ?? "",
		columnKey: issue?.columnKey ?? defaultColumn,
		sprintId: issue?.sprintId ?? "",
		milestoneId: issue?.milestoneId ?? "",
		urgency: issue?.priority.urgency ?? 2,
		importance: issue?.priority.importance ?? 2,
		difficulty: issue?.priority.difficulty ?? 3,
		reason: "",
		assigneeIds: issue?.assigneeIds ?? [],
		assigneeGroupIds: issue?.assigneeGroupIds ?? [],
		customFields: issue?.customFields ?? {},
		linkedIssues: issue?.linkedIssues ?? [],
	};
}
