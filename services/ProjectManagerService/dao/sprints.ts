import type { Model } from "mongoose";
import type { Sprint } from "@common/types/project-manager/Sprint.ts";
import type { ILogger } from "@interfaces/utils/ILogger.js";
import { generateId } from "@common/utils/crypto.ts";
import { type AuthVerifierGetter, PermissionChecker } from "@common/types/auth-verifier.ts";
import { PMScopes, PM_RESOURCE_NAME } from "@common/types/project-manager/permissions.ts";
import { CRUDXAction } from "@common/types/Actions.ts";
import { ProjectManagerError } from "@common/types/custom-errors/ProjectManagerError.ts";
import type { PMCtx, ProjectInternals } from "./projects.ts";
import type { Project } from "@common/types/project-manager/Project.ts";
import type { PMTierResolver } from "../utils/tier-resolver.ts";
import {
	docToPlain,
	fetchEntityWithProject,
	assertProjectVisible,
	projectMemberAllowIf,
	projectOwnerAllowIf,
	requireProject,
	stripImmutableFields,
} from "./shared.ts";

const SPRINT_IMMUTABLE_FIELDS = ["id", "projectId", "createdAt"] as const;

export class SprintManager {
	readonly #permissionChecker: PermissionChecker;
	readonly #kernelKey: symbol;

	constructor(
		private readonly sprintModel: Model<Sprint>,
		private readonly projectInternals: ProjectInternals,
		kernelKey: symbol,
		private readonly logger: ILogger,
		private readonly tierResolver: PMTierResolver,
		getAuthVerifier: AuthVerifierGetter = () => null
	) {
		this.#kernelKey = kernelKey;
		this.#permissionChecker = new PermissionChecker(getAuthVerifier, "SprintManager", PM_RESOURCE_NAME);
	}

	/** `allowIf` compartido: owner del proyecto o miembro explícito. */
	#projectMemberAllowIf(project: Project | null, ctx: PMCtx) {
		return projectMemberAllowIf(project, ctx);
	}

	async #requireProject(projectId: string): Promise<Project> {
		return requireProject(this.projectInternals, projectId);
	}

	async create(projectId: string, input: Partial<Sprint> & Pick<Sprint, "name">, ctx: PMCtx, token?: string): Promise<Sprint> {
		const project = await this.#requireProject(projectId);
		await this.#permissionChecker.requirePermission(token, CRUDXAction.WRITE, PMScopes.SPRINTS, {
			ownerId: project.ownerId,
			allowIf: projectOwnerAllowIf(project, ctx),
		});
		assertProjectVisible(project, ctx);

		const { maxSprintsPerProject } = await this.tierResolver.projectLimits(project);
		const count = await this.sprintModel.countDocuments({ projectId });
		if (count >= maxSprintsPerProject) {
			throw new ProjectManagerError(403, "TIER_LIMIT_REACHED", `Límite de sprints por proyecto alcanzado (${maxSprintsPerProject})`);
		}

		const sprint: Sprint = {
			id: generateId(),
			projectId,
			name: input.name,
			goal: input.goal,
			startDate: input.startDate,
			endDate: input.endDate,
			status: input.status ?? "planned",
			createdAt: new Date(),
		};
		await this.sprintModel.create(sprint);
		this.logger.logDebug(`Sprint ${sprint.name} creado en proyecto ${projectId}`);
		return sprint;
	}

	async list(projectId: string, ctx: PMCtx, token?: string): Promise<Sprint[]> {
		const project = await this.#requireProject(projectId);
		await this.#permissionChecker.requirePermission(token, CRUDXAction.READ, PMScopes.SPRINTS, {
			ownerId: project.ownerId,
			allowIf: this.#projectMemberAllowIf(project, ctx),
		});
		assertProjectVisible(project, ctx);
		const docs = await this.sprintModel.find({ projectId });
		return docs.map((d) => docToPlain<Sprint>(d)!);
	}

	async #fetchSprintAndProject(sprintId: string): Promise<{ sprint: Sprint | null; project: Project | null }> {
		const { entity, project } = await fetchEntityWithProject<Sprint>(this.sprintModel, sprintId, this.projectInternals);
		return { sprint: entity, project };
	}

	async get(sprintId: string, ctx: PMCtx, token?: string): Promise<Sprint | null> {
		const { sprint, project } = await this.#fetchSprintAndProject(sprintId);
		await this.#permissionChecker.requirePermission(token, CRUDXAction.READ, PMScopes.SPRINTS, {
			ownerId: project?.ownerId,
			allowIf: this.#projectMemberAllowIf(project, ctx),
		});
		assertProjectVisible(project, ctx);
		return sprint;
	}

	async update(sprintId: string, updates: Partial<Sprint>, ctx: PMCtx, token?: string): Promise<Sprint> {
		const { sprint, project } = await this.#fetchSprintAndProject(sprintId);
		if (!sprint) throw new ProjectManagerError(404, "SPRINT_NOT_FOUND", `Sprint ${sprintId} no encontrado`);
		// Update sobre sprints: rol PM / permiso formal, o owner del proyecto.
		await this.#permissionChecker.requirePermission(token, CRUDXAction.UPDATE, PMScopes.SPRINTS, {
			ownerId: project?.ownerId,
			allowIf: projectOwnerAllowIf(project, ctx),
		});
		assertProjectVisible(project, ctx);
		const safe = stripImmutableFields(updates, SPRINT_IMMUTABLE_FIELDS);
		const updated = await this.sprintModel.findOneAndUpdate({ id: sprintId }, safe, { new: true });
		if (!updated) throw new ProjectManagerError(404, "SPRINT_NOT_FOUND", `Sprint ${sprintId} no encontrado`);
		return docToPlain<Sprint>(updated)!;
	}

	async delete(sprintId: string, ctx: PMCtx, token?: string): Promise<void> {
		const { sprint, project } = await this.#fetchSprintAndProject(sprintId);
		await this.#permissionChecker.requirePermission(token, CRUDXAction.DELETE, PMScopes.SPRINTS, {
			ownerId: project?.ownerId,
			allowIf: projectOwnerAllowIf(project, ctx),
		});
		assertProjectVisible(project, ctx);
		if (!sprint) throw new ProjectManagerError(404, "SPRINT_NOT_FOUND", `Sprint ${sprintId} no encontrado`);
		const result = await this.sprintModel.deleteOne({ id: sprintId });
		if (result.deletedCount === 0) throw new ProjectManagerError(404, "SPRINT_NOT_FOUND", `Sprint ${sprintId} no encontrado`);
		this.logger.logDebug(`Sprint ${sprintId} eliminado`);
	}

	async setStatus(sprintId: string, status: Sprint["status"], ctx: PMCtx, token?: string): Promise<Sprint> {
		const { sprint, project } = await this.#fetchSprintAndProject(sprintId);
		if (!sprint) throw new ProjectManagerError(404, "SPRINT_NOT_FOUND", `Sprint ${sprintId} no encontrado`);
		await this.#permissionChecker.requirePermission(token, CRUDXAction.UPDATE, PMScopes.SPRINTS, {
			ownerId: project?.ownerId,
			allowIf: projectOwnerAllowIf(project, ctx),
		});
		assertProjectVisible(project, ctx);
		const updates: Partial<Sprint> = { status };
		if (status === "completed") updates.completedAt = new Date();
		const updated = await this.sprintModel.findOneAndUpdate({ id: sprintId }, updates, { new: true });
		if (!updated) throw new ProjectManagerError(404, "SPRINT_NOT_FOUND", `Sprint ${sprintId} no encontrado`);
		this.logger.logDebug(`Sprint ${sprintId} → ${status}`);
		return docToPlain<Sprint>(updated)!;
	}

	/** Borra todos los sprints de un proyecto. Uso interno (purga de cuenta), protegido por `kernelKey`. */
	async forceDeleteByProject(kernelKey: symbol, projectId: string): Promise<number> {
		if (kernelKey !== this.#kernelKey) throw new Error("Acceso denegado: kernel key inválida");
		const res = await this.sprintModel.deleteMany({ projectId });
		return res.deletedCount ?? 0;
	}
}
