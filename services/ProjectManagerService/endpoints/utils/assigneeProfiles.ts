import type ProjectManagerService from "../../index.js";
import type { Issue } from "@common/types/project-manager/Issue.ts";

type UserProfile = { username?: string; avatar?: string | null };
type GroupProfile = { name: string; description?: string };

/** IDs únicos de usuarios (reporter + assignees) y grupos referenciados por los issues. */
function collectAssigneeIds(list: Issue[]): { userIds: Set<string>; groupIds: Set<string> } {
	const userIds = new Set<string>();
	const groupIds = new Set<string>();
	for (const i of list) {
		if (i.reporterId) userIds.add(i.reporterId);
		for (const id of i.assigneeIds ?? []) userIds.add(id);
		for (const id of i.assigneeGroupIds ?? []) groupIds.add(id);
	}
	return { userIds, groupIds };
}

/** Proyecta `ids` sobre `map`, omitiendo los que no estén presentes. */
function pickProfiles<P>(ids: Iterable<string | undefined>, map: Map<string, P>): Record<string, P> {
	const out: Record<string, P> = {};
	for (const id of ids) {
		if (!id) continue;
		const p = map.get(id);
		if (p) out[id] = p;
	}
	return out;
}

/**
 * Resuelve perfiles públicos (username/avatar para usuarios, name/description
 * para grupos) referenciados por `reporterId`, `assigneeIds` y
 * `assigneeGroupIds` y los anexa a cada issue como `assigneeProfiles` /
 * `assigneeGroupProfiles`. Esto permite al frontend renderizar nombres sin
 * llamar a Identity (que podría devolver 401/403 si el usuario no tiene
 * permisos para leer `users`/`groups`).
 *
 * Tolera fallos: si IdentityManagerService no responde, devuelve los issues
 * tal cual (los pickers harán fallback a IDs como hasta ahora).
 */
export async function attachAssigneeProfiles<T extends Issue | Issue[]>(service: ProjectManagerService, target: T): Promise<T> {
	const list: Issue[] = Array.isArray(target) ? target : [target as Issue];
	if (list.length === 0) return target;
	const { userIds, groupIds } = collectAssigneeIds(list);
	try {
		const identity = service.identity;
		const [userMap, groupMap] = await Promise.all([
			userIds.size ? identity.users.getPublicProfiles([...userIds]) : Promise.resolve(new Map<string, UserProfile>()),
			groupIds.size ? identity.groups.getPublicProfiles([...groupIds]) : Promise.resolve(new Map<string, GroupProfile>()),
		]);
		for (const i of list) {
			i.assigneeProfiles = pickProfiles([i.reporterId, ...(i.assigneeIds ?? [])], userMap);
			i.assigneeGroupProfiles = pickProfiles(i.assigneeGroupIds ?? [], groupMap);
		}
	} catch {
		// Identity no disponible: dejamos los issues sin enriquecer.
	}
	return target;
}
