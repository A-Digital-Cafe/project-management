/**
 * Features de plan que Project Manager declara en `PlanService` al arrancar
 * (`registerFeatures`, scope `plans:register`).
 *
 * ⚠️ Los tiers pagos son **defaults de DESARROLLO**: la oferta real se publica
 * sobre `PlanService` (`PUT /api/plans/admin/plans`), que congela los planes para
 * que estos defaults no los pisen. El único valor real acá es el piso `free`/`default`,
 * que además es el fallback sin motor de planes.
 */

import type { FeatureDef, ModulePlanDefaults, PlanFeatureValue } from "@common/types/plans/index.ts";
import { PM_FREE_LIMITS, PM_ORG_BASE_LIMITS, type PMProjectLimits } from "./tier-resolver.ts";

export const PM_PLAN_FEATURES: FeatureDef[] = [
	{ key: "pm.maxProjects", module: "adc-project-manager", label: "plans.features.pm.maxProjects", kind: "limit", unit: "count", salesVisible: true },
	{ key: "pm.maxIssuesPerProject", module: "adc-project-manager", label: "plans.features.pm.maxIssues", kind: "limit", unit: "count" },
	{ key: "pm.maxSprintsPerProject", module: "adc-project-manager", label: "plans.features.pm.maxSprints", kind: "limit", unit: "count" },
	{ key: "pm.maxMilestonesPerProject", module: "adc-project-manager", label: "plans.features.pm.maxMilestones", kind: "limit", unit: "count" },
];

/** El pool de proyectos escala por asiento en el eje org; los topes por proyecto no. */
function features(maxProjects: number, perProject: PMProjectLimits, opts: { pooled: boolean }): Record<string, PlanFeatureValue> {
	return {
		"pm.maxProjects": opts.pooled ? { base: maxProjects, perSeat: 0 } : maxProjects,
		"pm.maxIssuesPerProject": perProject.maxIssuesPerProject,
		"pm.maxSprintsPerProject": perProject.maxSprintsPerProject,
		"pm.maxMilestonesPerProject": perProject.maxMilestonesPerProject,
	};
}

const DEV_VIP: PMProjectLimits = { maxIssuesPerProject: 60, maxSprintsPerProject: 4, maxMilestonesPerProject: 4 };
const DEV_PRO: PMProjectLimits = { maxIssuesPerProject: 200, maxSprintsPerProject: 10, maxMilestonesPerProject: 10 };
const DEV_PLUS: PMProjectLimits = { maxIssuesPerProject: 2000, maxSprintsPerProject: 100, maxMilestonesPerProject: 100 };

/** Proyectos del `pro` personal: el pool compartido del eje org se deriva de acá. */
const PRO_PROJECTS = 10;

/**
 * Cuántos planes `pro` equivale el pool de cada tier de organización. Es la misma
 * equivalencia con la que se fijó el precio por asiento, así que se deriva en vez
 * de escribirse a mano: si `pro` cambia, el pool acompaña.
 */
const ORG_PRO_EQUIVALENT = { team: 6, teamExpanded: 8, enterprise: 20 };

export const PM_PLAN_DEFAULTS: ModulePlanDefaults = {
	user: {
		free: features(PM_FREE_LIMITS.maxPrivateProjectsPerUser, PM_FREE_LIMITS, { pooled: false }),
		// `vip` se otorga por comunidad: duplica los topes de `free` y queda lejos de `pro`.
		vip: features(4, DEV_VIP, { pooled: false }),
		pro: features(PRO_PROJECTS, DEV_PRO, { pooled: false }),
		plus: features(50, DEV_PLUS, { pooled: false }),
	},
	org: {
		default: features(PM_ORG_BASE_LIMITS.maxProjectsPerOrg, PM_ORG_BASE_LIMITS, { pooled: true }),
		// Sólo el POOL de proyectos se multiplica; los topes POR proyecto (incidencias,
		// sprints) son calidad por persona y se quedan en los del tier equivalente.
		team: features(PRO_PROJECTS * ORG_PRO_EQUIVALENT.team, DEV_PRO, { pooled: true }),
		enterprise: features(PRO_PROJECTS * ORG_PRO_EQUIVALENT.enterprise, DEV_PLUS, { pooled: true }),
	},
	expansion: {
		team: { "pm.maxProjects": { base: PRO_PROJECTS * ORG_PRO_EQUIVALENT.teamExpanded, perSeat: 0 } },
	},
};
