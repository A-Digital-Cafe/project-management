/**
 * Features de plan que Project Manager declara en `PlanService` al arrancar
 * (`registerFeatures`, scope `plans:register`).
 *
 * ⚠️ Los valores de los tiers pagos son **defaults de DESARROLLO**, no la oferta
 * comercial. La oferta real se define fuera del código y se publica sobre
 * `PlanService` (`PUT /api/plans/admin/plans`), que congela los planes para que
 * estos defaults no los pisen. El único valor "real" acá es el piso
 * `free`/`default`, que además es el fallback sin motor de planes.
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

const DEV_PRO: PMProjectLimits = { maxIssuesPerProject: 200, maxSprintsPerProject: 10, maxMilestonesPerProject: 10 };
const DEV_PLUS: PMProjectLimits = { maxIssuesPerProject: 2000, maxSprintsPerProject: 100, maxMilestonesPerProject: 100 };

export const PM_PLAN_DEFAULTS: ModulePlanDefaults = {
	user: {
		free: features(PM_FREE_LIMITS.maxPrivateProjectsPerUser, PM_FREE_LIMITS, { pooled: false }),
		pro: features(10, DEV_PRO, { pooled: false }),
		plus: features(50, DEV_PLUS, { pooled: false }),
	},
	org: {
		default: features(PM_ORG_BASE_LIMITS.maxProjectsPerOrg, PM_ORG_BASE_LIMITS, { pooled: true }),
		team: features(30, DEV_PRO, { pooled: true }),
		enterprise: features(100, DEV_PLUS, { pooled: true }),
	},
	expansion: {
		team: { "pm.maxProjects": { base: 40, perSeat: 0 } },
	},
};
