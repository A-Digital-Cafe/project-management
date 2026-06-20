import type { Model } from "mongoose";
import type { Project, ProjectVisibility, KanbanColumn } from "@common/types/project-manager/Project.ts";
import type { CustomFieldDef } from "@common/types/project-manager/CustomField.ts";
import type { ILogger } from "@interfaces/utils/ILogger.js";
import { generateId, shortId } from "@common/utils/crypto.ts";
import { applyProjectDefaults, validateKanbanColumns } from "../utils/defaults.ts";
import { type AuthVerifierGetter, PermissionChecker } from "@common/types/auth-verifier.ts";
import { PMScopes, PM_RESOURCE_NAME } from "@common/types/project-manager/permissions.ts";
import { CRUDXAction } from "@common/types/Actions.ts";
import { ProjectManagerError } from "@common/types/custom-errors/ProjectManagerError.ts";
import { filterVisibleProjects, isProjectMember } from "../utils/project-access.ts";
import type { PMTierResolver } from "../utils/tier-resolver.ts";
import { docToPlain, stripImmutableFields } from "./shared.ts";

/** Campos que nunca deben mutarse vía un PUT genérico. */
const PROJECT_IMMUTABLE_FIELDS: readonly (keyof Project)[] = [
	"id",
	"createdAt",
	"issueCounter",
	// El ownership / visibilidad / contexto org se gestionan por endpoints dedicados.
	"ownerId",
	"orgId",
	"visibility",
	"slug",
];

interface ListProjectsContext {
	userId: string;
	groupIds: string[];
	tokenOrgId: string | null;
	hasGlobalPMRead: boolean;
	isGlobalAdmin: boolean;
}

/** Owner de los proyectos creados automáticamente por el servicio (tableros de tickets). */
const SYSTEM_OWNER_ID = "system";

/** Columna deseada para reconciliar un tablero (forma estructural, sin acoplar a tipos de tickets). */
export interface DesiredColumn {
	key: string;
	name: string;
	isAuto?: boolean;
	isDone?: boolean;
}

/** Compara dos sets de columnas por contenido relevante y orden (evita escrituras innecesarias). */
function sameColumns(a: readonly KanbanColumn[], b: readonly KanbanColumn[]): boolean {
	if (a.length !== b.length) return false;
	return a.every((c, i) => {
		const d = b[i];
		return (
			c.key === d.key &&
			c.name === d.name &&
			c.order === d.order &&
			Boolean(c.isAuto) === Boolean(d.isAuto) &&
			Boolean(c.isDone) === Boolean(d.isDone)
		);
	});
}

/** Compara dos listas (por orden) usando un predicado de igualdad por elemento. */
function arraysEqual<T>(a: readonly T[] | undefined, b: readonly T[] | undefined, eq: (x: T, y: T) => boolean): boolean {
	const aa = a ?? [];
	const bb = b ?? [];
	return aa.length === bb.length && aa.every((x, i) => eq(x, bb[i]));
}

/** Igualdad por contenido relevante de dos definiciones de custom field. */
function sameFieldDef(a: CustomFieldDef, b: CustomFieldDef): boolean {
	return (
		a.id === b.id &&
		a.name === b.name &&
		a.type === b.type &&
		Boolean(a.required) === Boolean(b.required) &&
		arraysEqual(a.options, b.options, (x, y) => x === y) &&
		arraysEqual(a.badgeOptions, b.badgeOptions, (x, y) => x.name === y.name && x.color === y.color)
	);
}

/** Compara dos sets de custom fields por contenido y orden (evita escrituras innecesarias). */
function sameFieldDefs(a: readonly CustomFieldDef[], b: readonly CustomFieldDef[]): boolean {
	return arraysEqual(a, b, sameFieldDef);
}

/** Contexto del caller para evaluar acceso alternativo por membresía. */
export interface CallerMembership {
	userId: string;
	groupIds: string[];
	tokenOrgId: string | null;
}

/**
 * Contexto PM resuelto del caller. Unificado para list/create/update/delete y
 * reutilizable por otros scopes (sprints/milestones/issues) que quieran
 * consultar flags de rol o quota sin repetir resolución.
 *
 * Campos derivados:
 *  - `isGlobalAdmin`: rol `Admin` a nivel global (token sin orgId).
 *  - `hasGlobalPMRead` / `hasGlobalPMWrite`: permisos formales globales.
 *  - `tokenOrgId`: `orgId` del token actual (modo org) o `null`.
 *  - `isOrgAdminOrPM(orgId)`: función memoizable para chequear admin/PM en una org.
 */
export interface PMCtx extends CallerMembership {
	tokenOrgId: string | null;
	isGlobalAdmin: boolean;
	hasGlobalPMRead: boolean;
	hasGlobalPMWrite: boolean;
	isOrgAdminOrPM: (orgId: string) => Promise<boolean>;
}

/**
 * Accesores internos para otros DAOs del mismo service. No consumirlos desde
 * endpoints: las operaciones aquí expuestas no pasan por `requirePermission`.
 */
export interface ProjectInternals {
	fetchProject: (projectId: string) => Promise<Project | null>;
	/** Resuelve un proyecto global (orgId null) por su slug. Uso interno. */
	fetchGlobalProjectBySlug: (slug: string) => Promise<Project | null>;
	/** Devuelve el proyecto global con ese slug; si no existe, lo crea con `desired`. */
	ensureGlobalProject: (slug: string, name: string, desired: ReadonlyArray<DesiredColumn>) => Promise<Project>;
	/** Deja el tablero exactamente con las columnas `desired` (agrega/elimina). Idempotente. */
	reconcileKanbanColumns: (projectId: string, desired: ReadonlyArray<DesiredColumn>) => Promise<Project | null>;
	/** Asegura (crea/actualiza) los custom fields `desired`, preservando los extra. Idempotente. */
	reconcileCustomFieldDefs: (projectId: string, desired: ReadonlyArray<CustomFieldDef>) => Promise<Project | null>;
	incrementIssueCounter: (projectId: string) => Promise<number>;
}

export class ProjectManager {
	readonly #permissionChecker: PermissionChecker;
	readonly #kernelKey: symbol;

	constructor(
		private readonly projectModel: Model<Project>,
		kernelKey: symbol,
		private readonly logger: ILogger,
		private readonly tierResolver: PMTierResolver,
		getAuthVerifier: AuthVerifierGetter = () => null
	) {
		this.#kernelKey = kernelKey;
		this.#permissionChecker = new PermissionChecker(getAuthVerifier, "ProjectManager", PM_RESOURCE_NAME);
	}

	async createProject(input: Partial<Project> & Pick<Project, "name" | "slug">, ctx: PMCtx, token?: string): Promise<Project> {
		// Toda creación requiere al menos token válido.
		const userId = await this.#permissionChecker.resolveUserId(token);
		const callerId = ctx.userId || userId || "";

		const visibility: ProjectVisibility = input.visibility ?? "private";
		const orgId = await this.#resolveCreateOrgId(visibility, ctx, input.orgId ?? null, callerId);

		const project = applyProjectDefaults({
			...input,
			id: generateId(),
			ownerId: input.ownerId ?? callerId,
			orgId,
			visibility,
		});

		validateKanbanColumns(project.kanbanColumns);

		try {
			await this.projectModel.create(project);
		} catch (error: any) {
			if (error.code === 11000) {
				throw new ProjectManagerError(409, "SLUG_TAKEN", `El slug '${project.slug}' ya existe en este contexto`);
			}
			throw error;
		}

		this.logger.logDebug(`Proyecto creado: ${project.slug} (org=${project.orgId ?? "GLOBAL"}, vis=${project.visibility})`);
		return project;
	}

	/** Resuelve y autoriza el `orgId` final del proyecto según su visibilidad. */
	#resolveCreateOrgId(visibility: ProjectVisibility, ctx: PMCtx, requestedOrgId: string | null, callerId: string): Promise<string | null> {
		switch (visibility) {
			case "public":
				return Promise.resolve(this.#authorizePublicProject(ctx));
			case "org":
				return this.#authorizeOrgProject(ctx, requestedOrgId);
			case "private":
				return this.#authorizePrivateProject(requestedOrgId, callerId);
			default:
				throw new ProjectManagerError(400, "INVALID_VISIBILITY", `Visibilidad desconocida: ${String(visibility)}`);
		}
	}

	/** Proyecto público: sólo admin global o usuario con PM.WRITE global (token sin orgId). */
	#authorizePublicProject(ctx: PMCtx): null {
		const allowed = ctx.isGlobalAdmin || (ctx.tokenOrgId === null && ctx.hasGlobalPMWrite);
		if (!allowed) {
			throw new ProjectManagerError(403, "PROJECT_ACCESS_DENIED", "Solo un admin global puede crear proyectos públicos");
		}
		return null;
	}

	/** Proyecto de organización: resuelve la org destino, exige Admin/PM en ella y su cuota. */
	async #authorizeOrgProject(ctx: PMCtx, requestedOrgId: string | null): Promise<string> {
		// Admin global elige org explícitamente; en modo org usa la del token.
		const targetOrg = ctx.isGlobalAdmin ? requestedOrgId : (ctx.tokenOrgId ?? requestedOrgId);
		if (!targetOrg) {
			throw new ProjectManagerError(400, "MISSING_FIELDS", "`orgId` requerido para proyecto de organización");
		}
		if (!ctx.isGlobalAdmin) {
			if (ctx.tokenOrgId && ctx.tokenOrgId !== targetOrg) {
				throw new ProjectManagerError(403, "ORG_ACCESS_DENIED", "No tienes acceso a esa organización");
			}
			if (!(await ctx.isOrgAdminOrPM(targetOrg))) {
				throw new ProjectManagerError(
					403,
					"PROJECT_ACCESS_DENIED",
					"Solo un Admin o Project Manager de la organización puede crear proyectos de organización"
				);
			}
		}
		await this.#enforceOrgProjectLimit(targetOrg);
		return targetOrg;
	}

	/** Proyecto privado: nunca asociado a una org; sujeto al límite de tier del usuario. */
	async #authorizePrivateProject(requestedOrgId: string | null, callerId: string): Promise<null> {
		if (requestedOrgId) {
			throw new ProjectManagerError(400, "INVALID_VISIBILITY", "Un proyecto privado no puede estar asociado a una organización");
		}
		await this.#enforcePrivateProjectLimit(callerId);
		return null;
	}

	async #enforcePrivateProjectLimit(userId: string): Promise<void> {
		if (!userId) return;
		// Recurso personal → tier del usuario dueño.
		const { maxPrivateProjectsPerUser } = await this.tierResolver.userLimits(userId);
		const count = await this.projectModel.countDocuments({ visibility: "private", ownerId: userId });
		if (count >= maxPrivateProjectsPerUser) {
			throw new ProjectManagerError(403, "TIER_LIMIT_REACHED", `Límite de proyectos privados alcanzado (${maxPrivateProjectsPerUser})`);
		}
	}

	async #enforceOrgProjectLimit(orgId: string): Promise<void> {
		// Recurso de organización → tier de la organización.
		const { maxProjectsPerOrg } = await this.tierResolver.orgLimits(orgId);
		const count = await this.projectModel.countDocuments({ orgId });
		if (count >= maxProjectsPerOrg) {
			throw new ProjectManagerError(403, "TIER_LIMIT_REACHED", `Límite de proyectos de la organización alcanzado (${maxProjectsPerOrg})`);
		}
	}

	async #fetchProject(projectId: string): Promise<Project | null> {
		return docToPlain<Project>(await this.projectModel.findOne({ id: projectId }));
	}

	async #fetchProjectBySlug(slug: string, orgId: string | null): Promise<Project | null> {
		return docToPlain<Project>(await this.projectModel.findOne({ slug, orgId }));
	}

	/** Convierte un set de columnas deseadas en `KanbanColumn[]`, preservando `id`/`color` de las existentes (match por `key`). */
	#desiredToColumns(desired: ReadonlyArray<DesiredColumn>, existing: readonly KanbanColumn[] = []): KanbanColumn[] {
		const byKey = new Map(existing.map((c) => [c.key, c]));
		return desired.map((d, i) => {
			const prev = byKey.get(d.key);
			return {
				id: prev?.id ?? shortId(),
				key: d.key,
				name: d.name,
				order: i,
				...(prev?.color ? { color: prev.color } : {}),
				isAuto: d.isAuto ?? false,
				isDone: d.isDone ?? false,
			};
		});
	}

	/**
	 * Devuelve el proyecto global (orgId null) con ese `slug`; si no existe, lo
	 * **crea** con las columnas `desired` (owner de sistema, visibilidad privada).
	 * Uso interno (sin auth de usuario).
	 */
	async #ensureGlobalProject(slug: string, name: string, desired: ReadonlyArray<DesiredColumn>): Promise<Project> {
		const existing = await this.#fetchProjectBySlug(slug, null);
		if (existing) return existing;

		const columns = this.#desiredToColumns(desired);
		validateKanbanColumns(columns);
		const project = applyProjectDefaults({
			id: generateId(),
			slug,
			name,
			ownerId: SYSTEM_OWNER_ID,
			visibility: "private",
			kanbanColumns: columns,
		});
		const created = await this.projectModel.create(project);
		this.logger.logInfo(`Proyecto de tablero creado automáticamente: "${slug}" (${project.id})`);
		return docToPlain<Project>(created)!;
	}

	/**
	 * Deja el tablero del proyecto EXACTAMENTE con las columnas `desired` (en ese
	 * orden): agrega las faltantes, elimina las sobrantes y preserva `id`/`color`
	 * de las que ya existían (match por `key`). Idempotente: si ya coincide, no
	 * escribe. Devuelve el proyecto actualizado (o `null` si no existe).
	 */
	async #reconcileKanbanColumns(projectId: string, desired: ReadonlyArray<DesiredColumn>): Promise<Project | null> {
		const project = await this.#fetchProject(projectId);
		if (!project) return null;

		const columns = this.#desiredToColumns(desired, project.kanbanColumns);

		if (sameColumns(project.kanbanColumns, columns)) return project;

		validateKanbanColumns(columns);
		const updated = await this.projectModel.findOneAndUpdate(
			{ id: projectId },
			{ kanbanColumns: columns, updatedAt: new Date() },
			{ new: true }
		);
		this.logger.logInfo(`Tablero reconciliado en proyecto ${projectId}: [${columns.map((c) => c.key).join(", ")}]`);
		return docToPlain<Project>(updated);
	}

	/**
	 * Asegura que el proyecto tenga los custom fields `desired` (crea los que
	 * falten y actualiza los existentes con el mismo `id` a su forma canónica),
	 * preservando los campos extra que un admin haya agregado a mano. Idempotente:
	 * si ya coincide, no escribe. Devuelve el proyecto actualizado (o `null` si no existe).
	 */
	async #reconcileCustomFieldDefs(projectId: string, desired: ReadonlyArray<CustomFieldDef>): Promise<Project | null> {
		const project = await this.#fetchProject(projectId);
		if (!project) return null;

		const canonicalIds = new Set(desired.map((d) => d.id));
		const extras = project.customFieldDefs.filter((d) => !canonicalIds.has(d.id));
		const merged: CustomFieldDef[] = [...desired.map((d) => ({ ...d })), ...extras];

		if (sameFieldDefs(project.customFieldDefs, merged)) return project;

		const updated = await this.projectModel.findOneAndUpdate(
			{ id: projectId },
			{ customFieldDefs: merged, updatedAt: new Date() },
			{ new: true }
		);
		this.logger.logInfo(`Campos personalizados reconciliados en proyecto ${projectId}: [${desired.map((d) => d.id).join(", ")}]`);
		return docToPlain<Project>(updated);
	}

	async getProject(projectId: string, token?: string, caller?: CallerMembership): Promise<Project | null> {
		const project = await this.#fetchProject(projectId);
		await this.#permissionChecker.requirePermission(token, CRUDXAction.READ, PMScopes.PROJECTS, {
			ownerId: project?.ownerId,
			allowIf: (uid) => isProjectMember(project, { id: uid, groupIds: caller?.groupIds ?? [] }, caller?.tokenOrgId ?? null),
		});
		return project;
	}

	async getProjectBySlug(slug: string, orgId: string | null, token?: string, caller?: CallerMembership): Promise<Project | null> {
		const project = await this.#fetchProjectBySlug(slug, orgId);
		await this.#permissionChecker.requirePermission(token, CRUDXAction.READ, PMScopes.PROJECTS, {
			ownerId: project?.ownerId,
			allowIf: (uid) => isProjectMember(project, { id: uid, groupIds: caller?.groupIds ?? [] }, caller?.tokenOrgId ?? null),
		});
		return project;
	}

	/** Comprobación pública de existencia de slug (no expone el proyecto). */
	async isSlugAvailable(slug: string, orgId: string | null, token?: string): Promise<boolean> {
		await this.#permissionChecker.resolveUserId(token);
		const existing = await this.#fetchProjectBySlug(slug, orgId);
		return !existing;
	}

	async listVisibleProjects(ctx: ListProjectsContext, token?: string): Promise<Project[]> {
		await this.#permissionChecker.resolveUserId(token);

		if (ctx.isGlobalAdmin) {
			const docs = await this.projectModel.find({});
			return docs.map((d) => docToPlain<Project>(d)!);
		}

		const orConditions: Record<string, unknown>[] = [];
		// Lectura global: sólo proyectos públicos (no privados) de contexto global.
		if (ctx.hasGlobalPMRead) orConditions.push({ orgId: null, visibility: { $ne: "private" } });
		// Dentro de una org: proyectos de la org (los privados por invariante no tienen orgId,
		// el filtro es defensivo por si quedaran datos antiguos).
		if (ctx.tokenOrgId) orConditions.push({ orgId: ctx.tokenOrgId, visibility: { $ne: "private" } });
		// Membresía: el token debe estar en el mismo contexto org que el proyecto.
		// Con token personal (tokenOrgId=null) sólo aplica a proyectos globales (orgId=null);
		// con token de org aplica a proyectos globales o de esa org.
		const membershipOrgFilter = ctx.tokenOrgId ? { orgId: { $in: [null, ctx.tokenOrgId] } } : { orgId: null };
		orConditions.push({ ...membershipOrgFilter, memberUserIds: ctx.userId }, { ...membershipOrgFilter, ownerId: ctx.userId });
		if (ctx.groupIds.length) orConditions.push({ ...membershipOrgFilter, memberGroupIds: { $in: ctx.groupIds } });

		const docs = orConditions.length ? await this.projectModel.find({ $or: orConditions }) : [];
		const projects = docs.map((d) => docToPlain<Project>(d)!);
		return filterVisibleProjects(projects, ctx);
	}

	async updateProject(projectId: string, updates: Partial<Project>, token?: string, _caller?: CallerMembership): Promise<Project> {
		const project = await this.#fetchProject(projectId);
		if (!project) throw new ProjectManagerError(404, "PROJECT_NOT_FOUND", `Proyecto ${projectId} no encontrado`);

		await this.#permissionChecker.requirePermission(token, CRUDXAction.UPDATE, PMScopes.PROJECTS, {
			ownerId: project.ownerId,
			allowIf: (uid) => project.ownerId === uid,
		});

		if (updates.kanbanColumns) validateKanbanColumns(updates.kanbanColumns);

		const safeUpdates = { ...stripImmutableFields(updates, PROJECT_IMMUTABLE_FIELDS), updatedAt: new Date() };

		const updated = await this.projectModel.findOneAndUpdate({ id: projectId }, safeUpdates, { new: true });
		if (!updated) throw new ProjectManagerError(404, "PROJECT_NOT_FOUND", `Proyecto ${projectId} no encontrado`);
		return docToPlain<Project>(updated)!;
	}

	async deleteProject(projectId: string, token?: string, caller?: CallerMembership): Promise<void> {
		const project = await this.#fetchProject(projectId);
		if (!project) throw new ProjectManagerError(404, "PROJECT_NOT_FOUND", `Proyecto ${projectId} no encontrado`);

		await this.#permissionChecker.requirePermission(token, CRUDXAction.DELETE, PMScopes.PROJECTS, {
			ownerId: project.ownerId,
			// El owner de un proyecto privado puede eliminarlo aunque no tenga PM.DELETE global.
			allowIf: (uid) => project.visibility === "private" && project.ownerId === uid && uid === (caller?.userId ?? uid),
		});

		const result = await this.projectModel.deleteOne({ id: projectId });
		if (result.deletedCount === 0) {
			throw new ProjectManagerError(404, "PROJECT_NOT_FOUND", `Proyecto ${projectId} no encontrado`);
		}
		this.logger.logDebug(`Proyecto eliminado: ${projectId}`);
	}

	async #incrementIssueCounter(projectId: string): Promise<number> {
		const updated = await this.projectModel.findOneAndUpdate({ id: projectId }, { $inc: { issueCounter: 1 } }, { new: true });
		if (!updated) throw new ProjectManagerError(404, "PROJECT_NOT_FOUND", `Proyecto ${projectId} no encontrado`);
		return docToPlain<Project>(updated)!.issueCounter;
	}

	/**
	 * Devuelve accesores sin autorización para uso exclusivo de otros DAOs del
	 * mismo service. Protegido por `kernelKey`: sólo el service que creó este
	 * manager puede obtenerlos.
	 */
	getInternals(_kernelKey: symbol): ProjectInternals {
		if (_kernelKey !== this.#kernelKey) throw new Error("Acceso denegado: kernel key inválida");

		return {
			fetchProject: (id) => this.#fetchProject(id),
			fetchGlobalProjectBySlug: (slug) => this.#fetchProjectBySlug(slug, null),
			ensureGlobalProject: (slug, name, desired) => this.#ensureGlobalProject(slug, name, desired),
			reconcileKanbanColumns: (id, desired) => this.#reconcileKanbanColumns(id, desired),
			reconcileCustomFieldDefs: (id, desired) => this.#reconcileCustomFieldDefs(id, desired),
			incrementIssueCounter: (id) => this.#incrementIssueCounter(id),
		};
	}

	/**
	 * IDs de los proyectos privados de un usuario. Uso interno (purga de cuenta
	 * tras retención): sin autorización, protegido por `kernelKey`.
	 */
	async listPrivateProjectIdsByOwner(_kernelKey: symbol, ownerId: string): Promise<string[]> {
		if (_kernelKey !== this.#kernelKey) throw new Error("Acceso denegado: kernel key inválida");
		if (!ownerId) return [];
		const docs = await this.projectModel.find({ visibility: "private", ownerId }, { id: 1 }).lean<{ id: string }[]>();
		return docs.map((d) => d.id);
	}

	/**
	 * Borrado definitivo de proyectos por id. Uso interno (purga de cuenta):
	 * sin autorización, protegido por `kernelKey`. Las cascadas (issues, sprints,
	 * milestones, adjuntos, comentarios) las orquesta el service.
	 */
	async forceDeleteProjects(_kernelKey: symbol, projectIds: string[]): Promise<number> {
		if (_kernelKey !== this.#kernelKey) throw new Error("Acceso denegado: kernel key inválida");
		if (projectIds.length === 0) return 0;
		const res = await this.projectModel.deleteMany({ id: { $in: projectIds } });
		return res.deletedCount ?? 0;
	}
}
