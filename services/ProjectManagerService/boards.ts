import type { ILogger } from "@interfaces/utils/ILogger.js";
import type { CustomFieldDef } from "@common/types/project-manager/CustomField.ts";
import type { Project } from "@common/types/project-manager/Project.ts";
import type { SupportTicketType } from "@common/types/project-manager/SupportTicket.ts";
import { BUG_BOUNTY_SEVERITIES, type RewardPreference } from "@common/types/project-manager/BugBounty.ts";
import type { ProjectManager, IssueManager } from "./dao/index.js";

/**
 * Tableros de tickets gestionados por el servicio (no por usuarios). Lo que hay
 * acá es interno del PM backend (creación de tickets + reconciliación de los
 * tableros en el arranque), por eso vive dentro del módulo y no en `@common`.
 */

/** Todas las claves de columna que puede tener un tablero de tickets. */
type TicketColumnKey = "organizations" | "support" | "security" | "expansion" | "in_progress" | "done" | "duplicate" | "rejected";

/** Definición de una columna canónica de un tablero de tickets. */
interface TicketBoardColumn {
	key: TicketColumnKey;
	name: string;
	/** Columna donde caen los issues recién creados / reasignados (default). */
	isAuto?: boolean;
	/** Columna de cierre. */
	isDone?: boolean;
}

/** Tablero canónico de **solicitudes de organización**. */
const ORG_REQUESTS_BOARD_COLUMNS = [
	{ key: "organizations", name: "Solicitudes", isAuto: true },
	{ key: "done", name: "Resuelto", isDone: true },
] as const satisfies ReadonlyArray<TicketBoardColumn>;

/**
 * Tablero canónico de **tickets de soporte** (reclamos, sugerencias, datos,
 * ampliaciones y bug bounty).
 * El orden de columnas refleja el ciclo de vida; las keys son las que consume
 * `deriveBugBountyStatus` (ver `BUG_BOUNTY_COLUMN_STATUS`) para el log público.
 */
const TICKETS_BOARD_COLUMNS = [
	{ key: "support", name: "Soporte", isAuto: true },
	{ key: "security", name: "Seguridad / Bug Bounty" },
	{ key: "expansion", name: "Ampliaciones" },
	{ key: "in_progress", name: "En progreso" },
	{ key: "done", name: "Resuelto", isDone: true },
	// Cerrar un reporte válido que llegó segundo no es descartarlo: el log público
	// lo publica como "Duplicado de <ticket>" en vez de confundirlo con spam.
	{ key: "duplicate", name: "Duplicado", isDone: true },
	{ key: "rejected", name: "Descartado", isDone: true },
] as const satisfies ReadonlyArray<TicketBoardColumn>;

/**
 * Columnas de cada tablero, derivadas de su definición: un ticket sólo puede
 * apuntar a una columna **de su propio tablero**. Sin esta separación el tipo
 * era una unión plana y aceptaba mandar un ticket de soporte a `organizations`
 * (columna del tablero de org-requests), dejándolo invisible en el kanban.
 */
type OrgRequestsColumnKey = (typeof ORG_REQUESTS_BOARD_COLUMNS)[number]["key"];
type TicketsBoardColumnKey = (typeof TICKETS_BOARD_COLUMNS)[number]["key"];

/** Columna destino de una creación (cualquiera de los dos tableros). */
export type CommonTicketColumnKey = OrgRequestsColumnKey | TicketsBoardColumnKey;

/** Columna del tablero de org-requests donde cae toda solicitud de alta. */
export const ORG_REQUEST_COLUMN_KEY: OrgRequestsColumnKey = "organizations";

/**
 * Mapea cada tipo de ticket de soporte a su columna **en el tablero de tickets**.
 * Garantiza que cada tipo caiga en una columna específica del tablero.
 */
export const TICKET_COLUMN_MAP = {
	complaint: "support",
	suggestion: "support",
	security: "security",
	data: "support",
	// La ampliación es una solicitud de una organización, pero entra por el
	// formulario de tickets: vive en el tablero de tickets, en su propia columna.
	expansion: "expansion",
	minor: "support",
} as const satisfies Record<SupportTicketType, TicketsBoardColumnKey>;

/** Mapea cada tipo de ticket a la categoría del issue que se crea. */
export const TICKET_TYPE_CATEGORIES: Record<SupportTicketType, string> = {
	complaint: "bug",
	suggestion: "task",
	security: "security",
	data: "task",
	expansion: "task",
	minor: "task",
};

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
	// Clave del ticket original al mover una tarjeta a la columna "Duplicado".
	{ id: "duplicateOf", name: "Duplicado de", type: "text" },
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

/** Tablero de tickets al que apunta cada flujo de creación. */
export type TicketBoardKind = "org-requests" | "tickets";

/** Definición de cada tablero según los slugs configurados. */
function ticketBoardDefs(config: TicketBoardsConfig): Record<TicketBoardKind, TicketBoardDef> {
	return {
		"org-requests": {
			slug: (config.organizationRequestsProjectId || config.orgManagementProjectId || "").trim(),
			label: "solicitudes de organización",
			name: "Solicitudes de organización",
			columns: ORG_REQUESTS_BOARD_COLUMNS,
			fields: ORG_REQUESTS_BOARD_FIELDS,
		},
		tickets: {
			slug: (config.supportTicketsProjectId || config.orgManagementProjectId || "").trim(),
			label: "tickets de soporte",
			name: "Tickets de soporte / Bug bounty",
			columns: TICKETS_BOARD_COLUMNS,
			fields: TICKETS_BOARD_FIELDS,
		},
	};
}

/** `true` si ambos tableros quedaron apuntando al mismo proyecto (misconfig). */
function boardsCollide(boards: Record<TicketBoardKind, TicketBoardDef>): boolean {
	return !!boards["org-requests"].slug && boards["org-requests"].slug === boards.tickets.slug;
}

/**
 * Garantiza que el tablero exista y esté en su forma canónica (proyecto, columnas
 * y campos personalizados) y devuelve el proyecto; `null` si no hay slug configurado.
 *
 * Lo usan tanto la reconciliación de arranque como la creación de tickets: así un
 * tablero borrado a mano —o al que le falta una columna recién agregada al código—
 * se autogenera en la propia request, sin esperar al próximo arranque.
 */
export async function ensureTicketBoard(
	deps: { projects: ProjectManager; logger: ILogger },
	kernelKey: symbol,
	kind: TicketBoardKind,
	config: TicketBoardsConfig
): Promise<Project | null> {
	const boards = ticketBoardDefs(config);
	const board = boards[kind];
	if (!board.slug) return null;

	const internals = deps.projects.getInternals(kernelKey);
	const project = await internals.ensureGlobalProject(board.slug, board.name, board.columns);
	// Con ambos tableros en el mismo proyecto, reconciliar acá haría que cada tipo
	// de ticket le borre las columnas al otro; el arranque ya avisó del problema.
	if (boardsCollide(boards)) return project;

	const withColumns = (await internals.reconcileKanbanColumns(project.id, board.columns)) ?? project;
	return (await internals.reconcileCustomFieldDefs(withColumns.id, board.fields)) ?? withColumns;
}

/**
 * Reconcilia los tableros default de tickets: por cada uno deja sus columnas
 * canónicas exactas (agrega faltantes, borra sobrantes), asegura sus campos
 * personalizados y reasigna a la columna `isAuto` los issues cuya columna ya no
 * exista. Idempotente y no fatal (loguea warnings y continúa).
 */
export async function reconcileTicketBoards(deps: TicketBoardsDeps, kernelKey: symbol, config: TicketBoardsConfig): Promise<void> {
	const { issues, logger } = deps;
	const boardDefs = ticketBoardDefs(config);

	if (boardsCollide(boardDefs)) {
		logger.logWarn(
			`Los tableros de org-requests y tickets apuntan al mismo proyecto ("${boardDefs["org-requests"].slug}"). ` +
				`Configurá slugs distintos (PM_ORG_REQUESTS_PROJECT_ID / PM_SUPPORT_TICKETS_PROJECT_ID) para separarlos; ` +
				`solo se reconciliará el primero.`
		);
	}

	const seen = new Set<string>();
	for (const kind of ["org-requests", "tickets"] as const) {
		const board = boardDefs[kind];
		if (!board.slug || seen.has(board.slug)) continue;
		seen.add(board.slug);
		try {
			// Crea el proyecto del tablero si no existe; luego reconcilia columnas y campos.
			const reconciled = await ensureTicketBoard(deps, kernelKey, kind, config);
			if (!reconciled) continue;
			const validKeys = board.columns.map((c) => c.key);
			const fallback = board.columns.find((c) => c.isAuto)?.key ?? validKeys[0];
			const moved = await issues.reassignOrphanColumnsInternal(kernelKey, reconciled.id, validKeys, fallback);
			if (moved > 0) logger.logInfo(`Tablero de ${board.label}: ${moved} issue(s) reasignados a la columna "${fallback}".`);
		} catch (e) {
			logger.logWarn(`No se pudo preparar el tablero de ${board.label} ("${board.slug}"): ${(e as Error).message}`);
		}
	}
}
