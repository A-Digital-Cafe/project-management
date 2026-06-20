import type { ILogger } from "@interfaces/utils/ILogger.js";
import type { CustomFieldDef } from "@common/types/project-manager/CustomField.ts";
import type { SupportTicketType } from "@common/types/project-manager/SupportTicket.ts";
import { BUG_BOUNTY_SEVERITIES, type RewardPreference } from "@common/types/project-manager/BugBounty.ts";
import type { ProjectManager, IssueManager } from "./dao/index.js";

/**
 * Tableros de tickets gestionados por el servicio (no por usuarios). Lo que hay
 * acá es interno del PM backend (creación de tickets + reconciliación de los
 * tableros en el arranque), por eso vive dentro del módulo y no en `@common`.
 */

/** Columnas canónicas de los tableros de tickets. */
export type CommonTicketColumnKey = "organizations" | "support" | "security";

/**
 * Mapea cada tipo de ticket/solicitud a la columna donde se crea el issue.
 * Garantiza que cada tipo caiga en una columna específica del tablero.
 */
export const TICKET_COLUMN_MAP = {
	"org-request": "organizations",
	complaint: "support",
	suggestion: "support",
	security: "security",
	data: "support",
} as const satisfies Record<"org-request" | SupportTicketType, CommonTicketColumnKey>;

/** Mapea cada tipo de ticket a la categoría del issue que se crea. */
export const TICKET_TYPE_CATEGORIES: Record<SupportTicketType, string> = {
	complaint: "bug",
	suggestion: "task",
	security: "security",
	data: "task",
};

/** Columnas de ciclo de vida (no son destino de creación; solo de movimiento). */
type LifecycleColumnKey = "in_progress" | "done" | "rejected";

/** Definición de una columna canónica de un tablero de tickets. */
interface TicketBoardColumn {
	key: CommonTicketColumnKey | LifecycleColumnKey;
	name: string;
	/** Columna donde caen los issues recién creados / reasignados (default). */
	isAuto?: boolean;
	/** Columna de cierre. */
	isDone?: boolean;
}

/** Tablero canónico de **solicitudes de organización**. */
const ORG_REQUESTS_BOARD_COLUMNS: ReadonlyArray<TicketBoardColumn> = [
	{ key: "organizations", name: "Solicitudes", isAuto: true },
	{ key: "done", name: "Resuelto", isDone: true },
];

/**
 * Tablero canónico de **tickets de soporte** (reclamos, sugerencias, datos y bug bounty).
 * El orden de columnas refleja el ciclo de vida; las keys son las que consume
 * `deriveBugBountyStatus` (ver `BUG_BOUNTY_COLUMN_STATUS`) para el log público.
 */
const TICKETS_BOARD_COLUMNS: ReadonlyArray<TicketBoardColumn> = [
	{ key: "support", name: "Soporte", isAuto: true },
	{ key: "security", name: "Seguridad / Bug Bounty" },
	{ key: "in_progress", name: "En progreso" },
	{ key: "done", name: "Resuelto", isDone: true },
	{ key: "rejected", name: "Descartado", isDone: true },
];

/**
 * Campos personalizados canónicos de cada tablero. El `id` coincide con la clave
 * de `Issue.customFields` que escriben los managers, de modo que el valor se
 * renderice en la UI del PM. La reconciliación es aditiva: garantiza que existan
 * (creándolos/actualizándolos) y preserva los que un admin agregue a mano.
 */
const ORG_REQUESTS_BOARD_FIELDS: ReadonlyArray<CustomFieldDef> = [
	{ id: "organizationName", name: "Organización", type: "text" },
	{ id: "organizationEmail", name: "Email de la organización", type: "text" },
	{ id: "organizationUrl", name: "Sitio web", type: "text" },
	{ id: "requestedByEmail", name: "Email del solicitante", type: "text" },
	{ id: "requestIp", name: "IP del solicitante", type: "text" },
];

const TICKETS_BOARD_FIELDS: ReadonlyArray<CustomFieldDef> = [
	{ id: "reporterEmail", name: "Email del reportante", type: "text" },
	{ id: "severity", name: "Severidad", type: "label", options: [...BUG_BOUNTY_SEVERITIES] },
	{ id: "reportedAt", name: "Reportado el", type: "date" },
	{ id: "slaAckDueAt", name: "SLA acuse", type: "date" },
	{ id: "slaEtaDueAt", name: "SLA ETA", type: "date" },
	{ id: "rewardPreference", name: "Recompensa preferida", type: "label", options: ["plus", "pro"] satisfies RewardPreference[] },
	{ id: "rewardGranted", name: "Recompensa otorgada", type: "text" },
	{ id: "publicDisclosure", name: "Divulgación pública", type: "label", options: ["false", "true"] },
];

/** Tablero gestionado por el servicio: columnas + campos personalizados canónicos. */
interface TicketBoardDef {
	slug: string;
	label: string;
	name: string;
	columns: ReadonlyArray<TicketBoardColumn>;
	fields: ReadonlyArray<CustomFieldDef>;
}

/** Dependencias (managers + logger) necesarias para reconciliar los tableros. */
export interface TicketBoardsDeps {
	readonly projects: ProjectManager;
	readonly issues: IssueManager;
	readonly logger: ILogger;
}

/** Slugs configurados de los proyectos que respaldan los tableros de tickets. */
export interface TicketBoardsConfig {
	supportTicketsProjectId?: string;
	organizationRequestsProjectId?: string;
	orgManagementProjectId?: string;
}

/**
 * Reconcilia los tableros default de tickets: por cada uno deja sus columnas
 * canónicas exactas (agrega faltantes, borra sobrantes), asegura sus campos
 * personalizados y reasigna a la columna `isAuto` los issues cuya columna ya no
 * exista. Idempotente y no fatal (loguea warnings y continúa).
 */
export async function reconcileTicketBoards(deps: TicketBoardsDeps, kernelKey: symbol, config: TicketBoardsConfig): Promise<void> {
	const { projects, issues, logger } = deps;

	const orgSlug = (config.organizationRequestsProjectId || config.orgManagementProjectId || "").trim();
	const ticketsSlug = (config.supportTicketsProjectId || config.orgManagementProjectId || "").trim();

	if (orgSlug && orgSlug === ticketsSlug) {
		logger.logWarn(
			`Los tableros de org-requests y tickets apuntan al mismo proyecto ("${orgSlug}"). ` +
				`Configurá slugs distintos (PM_ORG_REQUESTS_PROJECT_ID / PM_SUPPORT_TICKETS_PROJECT_ID) para separarlos; ` +
				`solo se reconciliará el primero.`
		);
	}

	const boards: TicketBoardDef[] = [
		{
			slug: orgSlug,
			label: "solicitudes de organización",
			name: "Solicitudes de organización",
			columns: ORG_REQUESTS_BOARD_COLUMNS,
			fields: ORG_REQUESTS_BOARD_FIELDS,
		},
		{
			slug: ticketsSlug,
			label: "tickets de soporte",
			name: "Tickets de soporte / Bug bounty",
			columns: TICKETS_BOARD_COLUMNS,
			fields: TICKETS_BOARD_FIELDS,
		},
	];

	const internals = projects.getInternals(kernelKey);
	const seen = new Set<string>();
	for (const board of boards) {
		if (!board.slug || seen.has(board.slug)) continue;
		seen.add(board.slug);
		try {
			// Crea el proyecto del tablero si no existe; luego reconcilia columnas y campos.
			const project = await internals.ensureGlobalProject(board.slug, board.name, board.columns);
			const withColumns = (await internals.reconcileKanbanColumns(project.id, board.columns)) ?? project;
			const reconciled = (await internals.reconcileCustomFieldDefs(withColumns.id, board.fields)) ?? withColumns;
			const validKeys = board.columns.map((c) => c.key);
			const fallback = board.columns.find((c) => c.isAuto)?.key ?? validKeys[0];
			const moved = await issues.reassignOrphanColumnsInternal(kernelKey, reconciled.id, validKeys, fallback);
			if (moved > 0) logger.logInfo(`Tablero de ${board.label}: ${moved} issue(s) reasignados a la columna "${fallback}".`);
		} catch (e) {
			logger.logWarn(`No se pudo preparar el tablero de ${board.label} ("${board.slug}"): ${(e as Error).message}`);
		}
	}
}
