/**
 * Límites efectivos de Project Manager.
 *
 * Ya **no resuelve tiers**: eso lo hace `PlanService`, que es el único resolver de
 * la plataforma. Este módulo sólo traduce features del catálogo a la forma que
 * esperan los DAOs (`maxIssuesPerProject`, etc.), para no tocar sus call sites.
 *
 * Concepto conservado: los recursos **personales** (proyectos privados) consumen el
 * plan de la **cuenta**; los de una **organización**, el plan de la organización.
 * Ambos son independientes.
 *
 * **Degradación**: si `PlanService` no está cargado se aplican los límites del tier
 * base. Es la misma convención que `LimitsManager` ante un fallo de resolución
 * ("error → tier base"), y la elección segura: fallar hacia el tier más alto
 * regalaría plan premium durante toda la caída. `PlanService` vive en `src/` y viene
 * siempre con la plataforma, así que su ausencia es una falla a corregir, no un
 * estado normal — y mientras dure, quedar corto es preferible a quedar largo.
 */

import type { Project } from "@common/types/project-manager/Project.ts";
import type { EntitlementsGetter, FeatureValue, PlanSubject } from "@common/types/plans/index.ts";

/** Límites aplicables a un proyecto concreto (privado o de organización). */
export interface PMProjectLimits {
	/** Issues máximos por proyecto. */
	maxIssuesPerProject: number;
	/** Sprints máximos por proyecto. */
	maxSprintsPerProject: number;
	/** Milestones máximos por proyecto. */
	maxMilestonesPerProject: number;
}

/** Cuotas por usuario (recursos personales: proyectos privados). */
export interface PMUserTierLimits extends PMProjectLimits {
	/** Proyectos privados que un usuario puede crear (visibility=private). */
	maxPrivateProjectsPerUser: number;
}

/** Cuotas por organización (recursos de la org: tableros de organización). */
export interface PMOrgTierLimits extends PMProjectLimits {
	/** Proyectos que una organización puede contener. */
	maxProjectsPerOrg: number;
}

/**
 * Pisos del tier base de cada eje: fallback sin `PlanService` y default
 * `free`/`default` que este módulo registra en el catálogo. Los valores de los
 * tiers pagos ya no viven en el código: están en `plan_definitions`.
 */
export const PM_FREE_LIMITS: PMUserTierLimits = {
	maxPrivateProjectsPerUser: 2,
	maxIssuesPerProject: 30,
	maxSprintsPerProject: 2,
	maxMilestonesPerProject: 2,
};

export const PM_ORG_BASE_LIMITS: PMOrgTierLimits = {
	maxProjectsPerOrg: 2,
	maxIssuesPerProject: 30,
	maxSprintsPerProject: 2,
	maxMilestonesPerProject: 2,
};

export interface PMTierResolver {
	userLimits(userId: string): Promise<PMUserTierLimits>;
	orgLimits(orgId: string): Promise<PMOrgTierLimits>;
	/** Límites por-proyecto según su contexto (privado → usuario; org → org). */
	projectLimits(project: Pick<Project, "visibility" | "ownerId" | "orgId">): Promise<PMProjectLimits>;
}

/** Fallbacks: el tier base de cada eje (ver la nota de degradación arriba). */
const USER_FALLBACK = PM_FREE_LIMITS;
const ORG_FALLBACK = PM_ORG_BASE_LIMITS;

export function createPMTierResolver(getEntitlements: EntitlementsGetter): PMTierResolver {
	const featuresOf = async (subject: PlanSubject): Promise<Record<string, FeatureValue> | null> => {
		const entitlements = getEntitlements();
		if (!entitlements) return null;
		try {
			return (await entitlements.get(subject)).features;
		} catch {
			return null;
		}
	};

	const projectPart = (features: Record<string, FeatureValue> | null, fallback: PMProjectLimits): PMProjectLimits => ({
		maxIssuesPerProject: num(features?.["pm.maxIssuesPerProject"], fallback.maxIssuesPerProject),
		maxSprintsPerProject: num(features?.["pm.maxSprintsPerProject"], fallback.maxSprintsPerProject),
		maxMilestonesPerProject: num(features?.["pm.maxMilestonesPerProject"], fallback.maxMilestonesPerProject),
	});

	const userLimits = async (userId: string): Promise<PMUserTierLimits> => {
		const features = await featuresOf({ userId, orgId: null });
		return {
			maxPrivateProjectsPerUser: num(features?.["pm.maxProjects"], USER_FALLBACK.maxPrivateProjectsPerUser),
			...projectPart(features, USER_FALLBACK),
		};
	};

	const orgLimits = async (orgId: string): Promise<PMOrgTierLimits> => {
		// El sujeto en eje org sólo necesita el `orgId`; el `userId` afina overrides
		// por miembro, que acá no aplican (el límite es de la organización).
		const features = await featuresOf({ userId: "", orgId });
		return {
			maxProjectsPerOrg: num(features?.["pm.maxProjects"], ORG_FALLBACK.maxProjectsPerOrg),
			...projectPart(features, ORG_FALLBACK),
		};
	};

	return {
		userLimits,
		orgLimits,
		async projectLimits(project) {
			if (project.visibility === "private") return userLimits(project.ownerId);
			return project.orgId ? orgLimits(project.orgId) : orgLimits("");
		},
	};
}

function num(value: FeatureValue | undefined, fallback: number): number {
	return typeof value === "number" ? value : fallback;
}
