import "@ui-library/utils/react-jsx";
import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "@ui-library/utils/i18n-react";
import { router } from "@common/utils/router";
import { pmApi } from "./utils/pm-api.ts";
import { identityPmApi } from "./utils/identity-api.ts";
import type { Permission } from "@common/types/identity/Permission.ts";
import type { Project } from "@common/types/project-manager/Project.ts";
import { parseRoute, resolveProjectAccess } from "./utils/route.ts";
import { ProjectListView } from "./pages/ProjectListView.tsx";
import { ProjectDetailView } from "./pages/ProjectDetailView.tsx";
import { LandingView } from "./pages/LandingView.tsx";
import { clearErrors } from "@ui-library/utils/adc-fetch";
import { getSession } from "@ui-library/utils/session";

export default function App() {
	const { t, ready } = useTranslation({ namespace: "adc-project-manager", autoLoad: true });
	const [perms, setPerms] = useState<Permission[]>([]);
	const [caller, setCaller] = useState<{ userId: string; groupIds: string[] } | undefined>(undefined);
	const [loading, setLoading] = useState(true);
	const [unauthorized, setUnauthorized] = useState(false);
	const [orgId, setOrgId] = useState<string | undefined>(undefined);
	const [isAdmin, setIsAdmin] = useState(false);
	const [isOrgAdmin, setIsOrgAdmin] = useState(false);
	const [ownOrgSlug, setOwnOrgSlug] = useState<string>("default");
	const [selectedProject, setSelectedProject] = useState<Project | null>(null);
	const [selectedOrgSlug, setSelectedOrgSlug] = useState<string>("default");
	const [activeTab, setActiveTab] = useState("board");

	// Cache de orgId → orgSlug para no repetir lookups.
	const orgSlugCache = useRef<Map<string, string>>(new Map());

	const resolveOrgSlug = useCallback(async (projectOrgId: string | null | undefined): Promise<string> => {
		if (!projectOrgId) return "default";
		const cached = orgSlugCache.current.get(projectOrgId);
		if (cached) return cached;
		const res = await identityPmApi.getOrganizationSlug(projectOrgId);
		const slug = res.success && res.data?.slug ? res.data.slug : projectOrgId;
		orgSlugCache.current.set(projectOrgId, slug);
		return slug;
	}, []);

	// Restaura el proyecto seleccionado a partir de la URL actual (si la hay).
	const restoreFromUrl = useCallback(async () => {
		const route = parseRoute(router.getCurrentPath());
		if (!route.orgSlug || !route.projectSlug) return;
		const res = await pmApi.getProjectBySlug(route.orgSlug, route.projectSlug);
		if (res.success && res.data) {
			setSelectedProject(res.data);
			setSelectedOrgSlug(route.orgSlug);
			setActiveTab(route.tab || "board");
		} else {
			setSelectedProject(null);
			router.navigate("/");
		}
	}, []);

	const loadPermissions = useCallback(async () => {
		setLoading(true);
		clearErrors();
		const session = await getSession(true);
		const user = session.authenticated ? session.user : null;
		if (!user) {
			setUnauthorized(true);
			setLoading(false);
			return;
		}

		const userPerms = user.perms ?? [];
		setPerms(userPerms);
		setOrgId(user.orgId || undefined);
		setIsAdmin(!!user.isAdmin);
		setIsOrgAdmin(!!user.isOrgAdmin);
		setCaller({ userId: user.id, groupIds: user.groupIds ?? [] });

		// El acceso al app no requiere permiso formal PM.READ: miembros de algún
		// proyecto o usuarios que puedan crear uno privado también entran.
		if (!(await resolveProjectAccess(userPerms, user.id))) {
			setUnauthorized(true);
			setLoading(false);
			return;
		}

		// Resolver slug de la org propia (o "default" para contexto global) y
		// restaurar el proyecto seleccionado desde la URL.
		setOwnOrgSlug(await resolveOrgSlug(user.orgId));
		await restoreFromUrl();
		setLoading(false);
	}, [resolveOrgSlug, restoreFromUrl]);

	useEffect(() => {
		loadPermissions();
	}, [loadPermissions]);

	useEffect(() => {
		return router.setOnRouteChange(() => {
			clearErrors();
			loadPermissions();
		});
	}, []);

	const openProject = useCallback(
		async (project: Project) => {
			const orgSlug = await resolveOrgSlug(project.orgId);
			setSelectedProject(project);
			setSelectedOrgSlug(orgSlug);
			setActiveTab("board");
			router.navigate(`/${orgSlug}/${project.slug}`);
		},
		[resolveOrgSlug]
	);

	const backToProjects = useCallback(() => {
		setSelectedProject(null);
		clearErrors();
		router.navigate("/");
	}, []);

	const renderContent = () => {
		if (!ready || loading) {
			return (
				<div key="pm-loading" className="mx-auto px-4 py-8">
					<adc-skeleton variant="rectangular" height="48px" class="mb-6" />
					<adc-skeleton variant="rectangular" height="400px" />
				</div>
			);
		}

		if (unauthorized) {
			return <LandingView key="pm-landing" />;
		}

		return (
			<div key="pm-main" className="mx-auto px-4 py-8">
				{selectedProject ? (
					<ProjectDetailView
						project={selectedProject}
						orgSlug={selectedOrgSlug}
						perms={perms}
						caller={caller}
						activeTab={activeTab}
						onBack={backToProjects}
					/>
				) : (
					<>
						<h1 className="font-heading text-2xl font-bold text-text mb-6">{t("common.title")}</h1>
						<ProjectListView
							perms={perms}
							caller={caller}
							isAdmin={isAdmin}
							isOrgAdmin={isOrgAdmin}
							orgId={orgId}
							orgSlug={ownOrgSlug}
							onOpen={openProject}
						/>
					</>
				)}
			</div>
		);
	};

	return (
		<adc-layout>
			<div>{renderContent()}</div>
		</adc-layout>
	);
}
