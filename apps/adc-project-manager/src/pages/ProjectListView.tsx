import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "@ui-library/utils/i18n-react";
import { toast } from "@ui-library/utils/toast";
import type { Permission } from "@common/types/identity/Permission.ts";
import type { Project } from "@common/types/project-manager/Project.ts";
import { pmApi } from "../utils/pm-api.ts";
import { identityPmApi } from "../utils/identity-api.ts";
import { canCreateOrgProject, canCreatePublicProject, canDeleteProject } from "../utils/permissions.ts";
import { ProjectCard } from "../components/projects/ProjectCard.tsx";
import { CreateProjectModal, type ProjectFormState, type OrganizationOption } from "../components/projects/CreateProjectModal.tsx";

interface Props {
	perms: Permission[];
	caller?: { userId: string; groupIds: string[] };
	isAdmin: boolean;
	isOrgAdmin: boolean;
	orgId?: string;
	/** Slug de la organización propia (o "default" en contexto global). Se usa para el check de slug. */
	orgSlug: string;
	onOpen: (project: Project) => void;
}

export function ProjectListView({ perms, caller, isAdmin, isOrgAdmin, orgId, orgSlug, onOpen }: Readonly<Props>) {
	const { t } = useTranslation({ namespace: "adc-project-manager" });
	const [projects, setProjects] = useState<Project[]>([]);
	const [loading, setLoading] = useState(true);
	const [showCreate, setShowCreate] = useState(false);
	const [organizations, setOrganizations] = useState<OrganizationOption[]>([]);

	const allowed = useMemo(
		() => ({
			private: true,
			org: canCreateOrgProject({ isAdmin, isOrgAdmin, orgId, perms }),
			public: canCreatePublicProject({ isAdmin, isOrgAdmin, orgId, perms }),
		}),
		[isAdmin, isOrgAdmin, orgId, perms]
	);

	const canCreate = allowed.private || allowed.org || allowed.public;

	const load = useCallback(async () => {
		setLoading(true);
		const res = await pmApi.listProjects();
		if (res.success && res.data) setProjects(res.data.projects);
		setLoading(false);
	}, []);

	useEffect(() => {
		load();
	}, [load]);

	// Admin global: cargar listado de organizaciones para permitir elegir destino al crear un proyecto de org.
	useEffect(() => {
		if (!isAdmin || orgId) return;
		identityPmApi.listOrganizations().then((res) => {
			if (res.success && Array.isArray(res.data)) {
				setOrganizations(res.data.map((o) => ({ orgId: o.orgId, slug: o.slug })));
			}
		});
	}, [isAdmin, orgId]);

	const handleCreate = async (form: ProjectFormState) => {
		const targetOrgId = form.visibility === "org" ? (form.orgId ?? orgId ?? null) : null;
		const res = await pmApi.createProject({
			name: form.name,
			slug: form.slug,
			description: form.description,
			visibility: form.visibility,
			orgId: targetOrgId,
		});
		if (res.success) {
			setShowCreate(false);
			toast.success(t("common.created"));
			await load();
		}
	};

	const handleDelete = async (id: string) => {
		if (!globalThis.confirm(t("common.confirmDelete"))) return;
		const res = await pmApi.deleteProject(id);
		if (res.success) {
			toast.success(t("common.deleted"));
			await load();
		}
	};

	if (loading) return <adc-skeleton variant="rectangular" height="300px" />;

	return (
		<div className="space-y-4">
			<div className="flex justify-between items-center">
				<h2 className="font-heading text-xl font-semibold text-text">{t("projects.title")}</h2>
				{canCreate && (
					<adc-button variant="primary" onClick={() => setShowCreate(true)}>
						{t("projects.newProject")}
					</adc-button>
				)}
			</div>

			{projects.length === 0 ? (
				<div className="flex flex-col items-center gap-3 text-center py-12">
					<p className="text-muted">{t("projects.empty")}</p>
					{canCreate && (
						<adc-button variant="primary" onClick={() => setShowCreate(true)}>
							{t("projects.newProject")}
						</adc-button>
					)}
				</div>
			) : (
				<div className="grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
					{projects.map((p) => {
						const canDel = canDeleteProject(perms, p, caller);
						return (
							<ProjectCard
								key={p.id}
								project={p}
								canDelete={canDel}
								onOpen={onOpen}
								onDelete={canDel ? handleDelete : undefined}
							/>
						);
					})}
				</div>
			)}

			{showCreate && (
				<CreateProjectModal
					orgSlug={orgSlug}
					allowed={allowed}
					organizations={isAdmin && !orgId ? organizations : undefined}
					defaultOrgId={orgId ?? null}
					onClose={() => setShowCreate(false)}
					onSubmit={handleCreate}
				/>
			)}
		</div>
	);
}
