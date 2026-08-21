import { RegisterEndpoint, type EndpointCtx } from "@services/core/EndpointManagerService/index.js";
import { ProjectManagerError } from "@common/types/custom-errors/ProjectManagerError.ts";
import type ProjectManagerService from "../index.js";
import type { Sprint } from "@common/types/project-manager/Sprint.ts";
import * as SS from "./schemas/sprints.js";
import { IdParams, ProjectIdParams, OkResponse } from "./schemas/common.js";

const SPRINT_CREATE_RATE_LIMIT = { max: 20, timeWindow: 60_000 };
const SPRINT_UPDATE_RATE_LIMIT = { max: 30, timeWindow: 60_000 };
const SPRINT_DELETE_RATE_LIMIT = { max: 10, timeWindow: 60_000 };
const SPRINT_STATUS_RATE_LIMIT = { max: 20, timeWindow: 60_000 };

export class SprintEndpoints {
	private static service: ProjectManagerService;
	private static kernelKey: symbol;
	static init(service: ProjectManagerService, kernelKey: symbol): void {
		SprintEndpoints.service ??= service;
		SprintEndpoints.kernelKey ??= kernelKey;
	}

	@RegisterEndpoint({
		method: "GET",
		url: "/api/pm/projects/:projectId/sprints",
		deferAuth: true,
		options: {
			tag: "ProjectManagerService/Sprints",
			summary: "Lista los sprints de un proyecto",
			schema: { params: ProjectIdParams, response: { 200: SS.SprintsListResponse } },
		},
	})
	static async list(ctx: EndpointCtx<{ projectId: string }>) {
		const service = SprintEndpoints.service;
		const pmCtx = await service.buildPMCtx(SprintEndpoints.kernelKey, ctx);
		return { sprints: await service.sprints.list(ctx.params.projectId, pmCtx, ctx.token ?? undefined) };
	}

	@RegisterEndpoint({
		method: "POST",
		url: "/api/pm/projects/:projectId/sprints",
		deferAuth: true,
		options: {
			successStatus: 201,
			rateLimit: SPRINT_CREATE_RATE_LIMIT,
			tag: "ProjectManagerService/Sprints",
			summary: "Crea un sprint",
			schema: { params: ProjectIdParams, body: SS.CreateSprintBody, response: { 201: SS.SprintResponse } },
		},
	})
	static async create(ctx: EndpointCtx<{ projectId: string }, Partial<Sprint> & { name: string }>) {
		if (!ctx.data?.name) throw new ProjectManagerError(400, "MISSING_FIELDS", "`name` es requerido");
		const service = SprintEndpoints.service;
		const pmCtx = await service.buildPMCtx(SprintEndpoints.kernelKey, ctx);
		return service.sprints.create(ctx.params.projectId, ctx.data, pmCtx, ctx.token ?? undefined);
	}

	@RegisterEndpoint({
		method: "PUT",
		url: "/api/pm/sprints/:id",
		deferAuth: true,
		options: {
			rateLimit: SPRINT_UPDATE_RATE_LIMIT,
			tag: "ProjectManagerService/Sprints",
			summary: "Actualiza un sprint",
			schema: { params: IdParams, body: SS.UpdateSprintBody, response: { 200: SS.SprintResponse } },
		},
	})
	static async update(ctx: EndpointCtx<{ id: string }, Partial<Sprint>>) {
		const service = SprintEndpoints.service;
		const pmCtx = await service.buildPMCtx(SprintEndpoints.kernelKey, ctx);
		return service.sprints.update(ctx.params.id, ctx.data ?? {}, pmCtx, ctx.token ?? undefined);
	}

	@RegisterEndpoint({
		method: "DELETE",
		url: "/api/pm/sprints/:id",
		deferAuth: true,
		options: {
			rateLimit: SPRINT_DELETE_RATE_LIMIT,
			tag: "ProjectManagerService/Sprints",
			summary: "Elimina un sprint",
			schema: { params: IdParams, response: { 200: OkResponse } },
		},
	})
	static async delete(ctx: EndpointCtx<{ id: string }>) {
		const service = SprintEndpoints.service;
		const pmCtx = await service.buildPMCtx(SprintEndpoints.kernelKey, ctx);
		await service.sprints.delete(ctx.params.id, pmCtx, ctx.token ?? undefined);
		return { ok: true };
	}

	@RegisterEndpoint({
		method: "POST",
		url: "/api/pm/sprints/:id/start",
		deferAuth: true,
		options: {
			rateLimit: SPRINT_STATUS_RATE_LIMIT,
			tag: "ProjectManagerService/Sprints",
			summary: "Inicia un sprint (status = active)",
			schema: { params: IdParams, response: { 200: SS.SprintResponse } },
		},
	})
	static async start(ctx: EndpointCtx<{ id: string }>) {
		const service = SprintEndpoints.service;
		const pmCtx = await service.buildPMCtx(SprintEndpoints.kernelKey, ctx);
		return service.sprints.setStatus(ctx.params.id, "active", pmCtx, ctx.token ?? undefined);
	}

	@RegisterEndpoint({
		method: "POST",
		url: "/api/pm/sprints/:id/complete",
		deferAuth: true,
		options: {
			rateLimit: SPRINT_STATUS_RATE_LIMIT,
			tag: "ProjectManagerService/Sprints",
			summary: "Completa un sprint (status = completed)",
			schema: { params: IdParams, response: { 200: SS.SprintResponse } },
		},
	})
	static async complete(ctx: EndpointCtx<{ id: string }>) {
		const service = SprintEndpoints.service;
		const pmCtx = await service.buildPMCtx(SprintEndpoints.kernelKey, ctx);
		return service.sprints.setStatus(ctx.params.id, "completed", pmCtx, ctx.token ?? undefined);
	}
}
