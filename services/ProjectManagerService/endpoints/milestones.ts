import { RegisterEndpoint, type EndpointCtx } from "@services/core/EndpointManagerService/index.js";
import { ProjectManagerError } from "@common/types/custom-errors/ProjectManagerError.ts";
import type ProjectManagerService from "../index.js";
import type { Milestone } from "@common/types/project-manager/Milestone.ts";
import * as MS from "./schemas/milestones.js";
import { IdParams, ProjectIdParams, OkResponse } from "./schemas/common.js";

const MILESTONE_CREATE_RATE_LIMIT = { max: 20, timeWindow: 60_000 };
const MILESTONE_UPDATE_RATE_LIMIT = { max: 30, timeWindow: 60_000 };
const MILESTONE_DELETE_RATE_LIMIT = { max: 10, timeWindow: 60_000 };

export class MilestoneEndpoints {
	private static service: ProjectManagerService;
	private static kernelKey: symbol;
	static init(service: ProjectManagerService, kernelKey: symbol): void {
		MilestoneEndpoints.service ??= service;
		MilestoneEndpoints.kernelKey ??= kernelKey;
	}

	@RegisterEndpoint({
		method: "GET",
		url: "/api/pm/projects/:projectId/milestones",
		deferAuth: true,
		options: {
			tag: "ProjectManagerService/Milestones",
			summary: "Lista los milestones de un proyecto",
			schema: { params: ProjectIdParams, response: { 200: MS.MilestonesListResponse } },
		},
	})
	static async list(ctx: EndpointCtx<{ projectId: string }>) {
		const service = MilestoneEndpoints.service;
		const caller = await service.resolveCaller(MilestoneEndpoints.kernelKey, ctx);
		return { milestones: await service.milestones.list(ctx.params.projectId, ctx.token ?? undefined, caller) };
	}

	@RegisterEndpoint({
		method: "POST",
		url: "/api/pm/projects/:projectId/milestones",
		deferAuth: true,
		options: {
			successStatus: 201,
			rateLimit: MILESTONE_CREATE_RATE_LIMIT,
			tag: "ProjectManagerService/Milestones",
			summary: "Crea un milestone",
			schema: { params: ProjectIdParams, body: MS.CreateMilestoneBody, response: { 201: MS.MilestoneResponse } },
		},
	})
	static async create(ctx: EndpointCtx<{ projectId: string }, Partial<Milestone> & { name: string }>) {
		if (!ctx.data?.name) throw new ProjectManagerError(400, "MISSING_FIELDS", "`name` es requerido");
		const service = MilestoneEndpoints.service;
		const caller = await service.resolveCaller(MilestoneEndpoints.kernelKey, ctx);
		return service.milestones.create(ctx.params.projectId, ctx.data, ctx.token ?? undefined, caller);
	}

	@RegisterEndpoint({
		method: "PUT",
		url: "/api/pm/milestones/:id",
		deferAuth: true,
		options: {
			rateLimit: MILESTONE_UPDATE_RATE_LIMIT,
			tag: "ProjectManagerService/Milestones",
			summary: "Actualiza un milestone",
			schema: { params: IdParams, body: MS.UpdateMilestoneBody, response: { 200: MS.MilestoneResponse } },
		},
	})
	static async update(ctx: EndpointCtx<{ id: string }, Partial<Milestone>>) {
		const service = MilestoneEndpoints.service;
		const caller = await service.resolveCaller(MilestoneEndpoints.kernelKey, ctx);
		return service.milestones.update(ctx.params.id, ctx.data ?? {}, ctx.token ?? undefined, caller);
	}

	@RegisterEndpoint({
		method: "DELETE",
		url: "/api/pm/milestones/:id",
		deferAuth: true,
		options: {
			rateLimit: MILESTONE_DELETE_RATE_LIMIT,
			tag: "ProjectManagerService/Milestones",
			summary: "Elimina un milestone",
			schema: { params: IdParams, response: { 200: OkResponse } },
		},
	})
	static async delete(ctx: EndpointCtx<{ id: string }>) {
		const service = MilestoneEndpoints.service;
		const caller = await service.resolveCaller(MilestoneEndpoints.kernelKey, ctx);
		await service.milestones.delete(ctx.params.id, ctx.token ?? undefined, caller);
		return { ok: true };
	}
}
