/**
 * Resuelve los tiers (usuario / organización) y los límites efectivos de un
 * proyecto. Desacopla la lógica de cuotas de los managers, que sólo necesitan
 * preguntar "¿qué límites aplican a este proyecto?".
 *
 * Los recursos privados consumen el tier del usuario dueño; los de organización,
 * el tier de la organización (ver `tier-limits.ts`).
 */

import type { Project } from "@common/types/project-manager/Project.ts";
import type { AccountTier } from "@common/types/tiers.ts";
import type { OrganizationTier } from "@common/types/identity/Organization.ts";
import {
	getPMUserTierLimits,
	getPMOrgTierLimits,
	type PMUserTierLimits,
	type PMOrgTierLimits,
	type PMProjectLimits,
} from "@common/types/tiers/project-manager.ts";

/** Fuente mínima de datos de usuario/organización para resolver tiers. */
interface TierUsersSource {
	getUser(userId: string, token?: string): Promise<{ metadata?: { accountTier?: string } | null } | null>;
}
interface TierOrgsSource {
	getOrganization(idOrSlug: string, token?: string): Promise<{ tier?: string } | null>;
}

export interface PMTierResolver {
	userTier(userId: string): Promise<AccountTier>;
	orgTier(orgId: string): Promise<OrganizationTier>;
	userLimits(userId: string): Promise<PMUserTierLimits>;
	orgLimits(orgId: string): Promise<PMOrgTierLimits>;
	/** Límites por-proyecto según su contexto (privado → usuario; org → org). */
	projectLimits(project: Pick<Project, "visibility" | "ownerId" | "orgId">): Promise<PMProjectLimits>;
}

/**
 * Crea un resolver usando managers internos (sin auth) de IdentityManager.
 * Tolerante a fallos: ante cualquier error devuelve el tier por defecto.
 */
export function createPMTierResolver(users: TierUsersSource, orgs: TierOrgsSource): PMTierResolver {
	const userTier = async (userId: string): Promise<AccountTier> => {
		if (!userId) return "free";
		const u = await users.getUser(userId).catch(() => null);
		return (u?.metadata?.accountTier as AccountTier) ?? "free";
	};
	const orgTier = async (orgId: string): Promise<OrganizationTier> => {
		if (!orgId) return "default";
		const o = await orgs.getOrganization(orgId).catch(() => null);
		return (o?.tier as OrganizationTier) ?? "default";
	};
	return {
		userTier,
		orgTier,
		async userLimits(userId) {
			return getPMUserTierLimits(await userTier(userId));
		},
		async orgLimits(orgId) {
			return getPMOrgTierLimits(await orgTier(orgId));
		},
		async projectLimits(project) {
			if (project.visibility === "private") {
				return getPMUserTierLimits(await userTier(project.ownerId));
			}
			return getPMOrgTierLimits(project.orgId ? await orgTier(project.orgId) : "default");
		},
	};
}
