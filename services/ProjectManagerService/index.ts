import type MongoProvider from "@providers/object/mongo/index.js";
import { BaseService } from "@services/BaseService.js";
import { projectSchema, sprintSchema, milestoneSchema, issueSchema } from "./domain/index.js";
import { ProjectManager, SprintManager, MilestoneManager, IssueManager, OrganizationRequestManager, SupportTicketManager } from "./dao/index.js";
import { type IAuthVerifier, type AuthVerifierGetter } from "@common/types/auth-verifier.ts";
import type { IIdentityManagerService } from "@common/types/identity/IIdentityManagerService.js";
import { SystemRole } from "@services/core/IdentityManagerService/defaults/systemRoles.js";
import type { EndpointCtx } from "@services/core/EndpointManagerService/index.js";
import { EnableEndpoints, DisableEndpoints } from "@services/core/EndpointManagerService/index.js";
import { ProjectEndpoints } from "./endpoints/projects.js";
import { SprintEndpoints } from "./endpoints/sprints.js";
import { MilestoneEndpoints } from "./endpoints/milestones.js";
import { IssueEndpoints } from "./endpoints/issues.js";
import { IssueDescriptionEndpoints } from "./endpoints/issueDescription.js";
import { IssueCommentsEndpoints } from "./endpoints/comments.js";
import { IssueAttachmentsEndpoints } from "./endpoints/attachments.js";
import { OrganizationRequestEndpoints } from "./endpoints/orgRequests.js";
import { SupportTicketEndpoints } from "./endpoints/supportTickets.js";
import { PMScopes } from "@common/types/project-manager/permissions.ts";
import { CRUDXAction } from "@common/types/Actions.ts";
import { OnlyKernel } from "@adc/utils/decorators/OnlyKernel.ts";
import { Scope, assertScope, type CapabilityToken } from "@common/security/Capability.ts";
import type { Project } from "@common/types/project-manager/Project.ts";
import type { Sprint } from "@common/types/project-manager/Sprint.ts";
import type { Milestone } from "@common/types/project-manager/Milestone.ts";
import type { Issue } from "@common/types/project-manager/Issue.ts";
import type { CallerMembership, PMCtx, ProjectInternals } from "./dao/projects.ts";
import { Kernel } from "@kernel";
import { hasGlobalAdminRole, isOrgAdminOrPM } from "./utils/pm-roles.ts";
import type AttachmentsUtility from "@utilities/attachments/attachments-utility/index.js";
import type CommentsUtility from "@utilities/comments/comments-utility/index.js";
import type { AttachmentsManager, SubPathContext } from "@utilities/attachments/attachments-utility/index.js";
import type { CommentsManager } from "@utilities/comments/comments-utility/index.js";
import { DraftsRepository, getOrCreateCommentDraftModel } from "@utilities/comments/comments-utility/index.js";
import type InternalS3Provider from "@providers/object/internal-s3-provider/index.js";
import { issueAttachmentsChecker } from "./permissions/issueAttachments.ts";
import { issueCommentsChecker } from "./permissions/issueComments.ts";
import { createPMTierResolver } from "./utils/tier-resolver.ts";
import { PM_PLAN_FEATURES, PM_PLAN_DEFAULTS } from "./utils/plan-features.ts";
import { createEntitlementsGetter, registerPlanFeatures } from "@common/types/plans/consumers.js";
import type { IPlanService } from "@common/types/plans/IPlanService.js";
import { ProjectManagerError as ProjectManagerErrorRef } from "@common/types/custom-errors/ProjectManagerError.ts";
import { createQuotaTrackerGetter, registerStorageApp } from "@services/data/StorageQuotaService/index.js";
import type { IStorageQuotaService } from "@common/types/storage/IStorageQuotaService.js";
import { purgePrivateProjectData } from "./maintenance.ts";
import { reconcileTicketBoards, type TicketBoardsConfig } from "./boards.ts";
import { NotifyManager } from "./notify.ts";

/** Mínimo de almacenamiento garantizado para adjuntos de issues/comentarios. */

export default class ProjectManagerService extends BaseService {
	public readonly name = "ProjectManagerService";

	#projectManager: ProjectManager | null = null;
	#sprintManager: SprintManager | null = null;
	#milestoneManager: MilestoneManager | null = null;
	#issueManager: IssueManager | null = null;
	#organizationRequestManager: OrganizationRequestManager | null = null;
	#supportTicketManager: SupportTicketManager | null = null;
	#issueAttachmentsManager: AttachmentsManager | null = null;
	#issueCommentsManager: CommentsManager | null = null;
	#issueDescriptionDrafts: DraftsRepository | null = null;
	#notifyManager: NotifyManager | null = null;

	#authVerifier: IAuthVerifier | null = null;
	#identity: IIdentityManagerService | null = null;
	#internalRoles: ReturnType<IIdentityManagerService["_internal"]>["roles"] | null = null;
	#internalOrgs: ReturnType<IIdentityManagerService["_internal"]>["organizations"] | null = null;
	#projectInternals: ProjectInternals | null = null;
	/** Token de ciclo de vida propio (para la purga interna que ejecuta con SU token, no el del caller). */
	#lifecycleKey: symbol | null = null;

	private mongoProvider!: MongoProvider;

	constructor(kernel: Kernel, options?: any) {
		super(kernel, options);
	}

	/** Re-registra la app en StorageQuotaService cuando éste se reinicia (dep opcional). */
	#reRegisterStorage: (() => void) | null = null;

	public override onDependencyRestored(dependencyName: string): void {
		if (dependencyName === "StorageQuotaService") this.#reRegisterStorage?.();
		if (dependencyName === "PlanService") this.#registerPlanFeatures();
	}

	/** Declara las features de PM y sus defaults en el motor de planes (fail-open). */
	#registerPlanFeatures(): void {
		void registerPlanFeatures(() => this.tryGetMyService<IPlanService>("PlanService"), this.getCapability(), PM_PLAN_FEATURES, PM_PLAN_DEFAULTS);
	}

	readonly #getAuthVerifier: AuthVerifierGetter = () => this.#authVerifier;

	@EnableEndpoints({
		managers: () => [
			ProjectEndpoints,
			SprintEndpoints,
			MilestoneEndpoints,
			IssueEndpoints,
			IssueDescriptionEndpoints,
			IssueCommentsEndpoints,
			IssueAttachmentsEndpoints,
			OrganizationRequestEndpoints,
			SupportTicketEndpoints,
		],
	})
	async start(kernelKey: symbol): Promise<void> {
		await super.start(kernelKey);
		this.#lifecycleKey = kernelKey;

		this.mongoProvider = this.getMyProvider<MongoProvider>("object/mongo");
		await this.waitForMongo();

		this.#identity = this.getMyService<IIdentityManagerService>("IdentityManagerService");
		const internalIdentity = this.#identity?._internal(this.getCapability()) ?? null;
		this.#internalRoles = internalIdentity?.roles ?? null;
		this.#internalOrgs = internalIdentity?.organizations ?? null;
		// Límites vía PlanService (único resolver de tiers de la plataforma). Getter
		// perezoso: es dependencia opcional, y si falta se degrada al tier más alto.
		const tierResolver = createPMTierResolver(createEntitlementsGetter(() => this.tryGetMyService<IPlanService>("PlanService")));
		this.#registerPlanFeatures();

		const ProjectModel = this.mongoProvider.createModel<Project>("projects", projectSchema);
		const SprintModel = this.mongoProvider.createModel<Sprint>("sprints", sprintSchema);
		const MilestoneModel = this.mongoProvider.createModel<Milestone>("milestones", milestoneSchema);
		const IssueModel = this.mongoProvider.createModel<Issue>("issues", issueSchema);

		this.#projectManager = new ProjectManager(ProjectModel, kernelKey, this.logger, tierResolver, this.#getAuthVerifier);
		const projectInternals = this.#projectManager.getInternals(kernelKey);
		this.#projectInternals = projectInternals;
		this.#sprintManager = new SprintManager(SprintModel, projectInternals, kernelKey, this.logger, tierResolver, this.#getAuthVerifier);
		this.#milestoneManager = new MilestoneManager(
			MilestoneModel,
			projectInternals,
			kernelKey,
			this.logger,
			tierResolver,
			this.#getAuthVerifier
		);
		this.#issueManager = new IssueManager(IssueModel, projectInternals, kernelKey, this.logger, tierResolver, this.#getAuthVerifier);
		this.#organizationRequestManager = new OrganizationRequestManager(
			this.#projectManager,
			this.#issueManager,
			this.logger,
			(this.config?.private ?? {}) as { organizationRequestsProjectId?: string; orgManagementProjectId?: string }
		);
		this.#supportTicketManager = new SupportTicketManager(
			this.#projectManager,
			this.#issueManager,
			this.logger,
			(this.config?.private ?? {}) as { supportTicketsProjectId?: string; orgManagementProjectId?: string }
		);

		// Notificaciones de dominio: emisor desacoplado + resolutores (la enumeración
		// de admins va por el gate `_internal(kernelKey)`, no por una API pública).
		this.#notifyManager = new NotifyManager({
			emit: (input) => this.emitNotification(input),
			projectPath: (projectId) => this.#projectPath(projectId),
			getAdminUserIds: () => internalIdentity?.getUserIdsByRoleName(SystemRole.ADMIN) ?? Promise.resolve([]),
			orgRequestsPath: () => this.organizationRequests.appPath ?? "/",
		});

		this.#authVerifier = this.#identity.createAuthVerifier();

		// --- Attachments + Comments wiring ---
		try {
			// Getter, no instancia: el provider se resuelve en cada uso para que una recarga
			// en caliente no deje al manager hablándole a una instancia detenida.
			const s3 = () => this.getMyProvider<InternalS3Provider>("object/internal-s3-provider");
			const attachmentsUtil = this.getMyUtility<AttachmentsUtility>("attachments-utility");
			const commentsUtil = this.getMyUtility<CommentsUtility>("comments-utility");
			const connection = this.mongoProvider.getConnection();

			this.#issueAttachmentsManager = attachmentsUtil.createAttachmentsManager({
				mongoConnection: connection,
				collectionName: "pm_attachments",
				s3Provider: s3,
				basePath: "projects",
				subPathResolver: (ctx: SubPathContext) => {
					const projectId = (ctx as any).project?.id ?? "_";
					const issueId = (ctx as any).issue?.id ?? ctx.ownerId ?? "_";
					return ctx.ownerType === "pm-issue-comment" ? `${projectId}/${issueId}/comments` : `${projectId}/${issueId}`;
				},
				permissionChecker: issueAttachmentsChecker,
				kernelKey,
				quota: { appId: "project-manager", getTracker: createQuotaTrackerGetter(() => this.tryGetMyService<IStorageQuotaService>("StorageQuotaService")) },
				logger: this.logger,
			});

			const issueAttachments = this.#issueAttachmentsManager;
			const quotaApp = {
				appId: "project-manager",
				label: "Projects",
				computeUsage: () => issueAttachments.aggregateUsageByUser(kernelKey),
			};
			this.#reRegisterStorage = () => registerStorageApp(() => this.tryGetMyService<IStorageQuotaService>("StorageQuotaService"), this.getCapability(), quotaApp);
			this.#reRegisterStorage();

			this.#issueCommentsManager = commentsUtil.createCommentsManager({
				mongoConnection: connection,
				collectionName: "pm_comments",
				attachmentsManager: this.#issueAttachmentsManager,
				permissionChecker: issueCommentsChecker,
				attachmentsKernelKey: kernelKey,
			});

			// Drafts de descripción de issue: reutilizan el schema de drafts (genérico
			// por targetType) en una colección separada con TTL de 7 días.
			const descriptionDraftModel = getOrCreateCommentDraftModel(connection, "pm_descriptions_drafts");
			this.#issueDescriptionDrafts = new DraftsRepository(descriptionDraftModel, 200);
		} catch (e) {
			const err = e as Error;
			this.logger.logWarn(
				`No se pudieron inicializar attachments/comments del PM: ${err.message}. Endpoints relacionados fallarán con 503 hasta que estén disponibles.`
			);
			if (err.stack) this.logger.logDebug(err.stack);
		}

		ProjectEndpoints.init(this, kernelKey);
		SprintEndpoints.init(this, kernelKey);
		MilestoneEndpoints.init(this, kernelKey);
		IssueEndpoints.init(this, kernelKey);
		IssueDescriptionEndpoints.init(this, kernelKey);
		IssueCommentsEndpoints.init(this, kernelKey);
		IssueAttachmentsEndpoints.init(this, kernelKey);
		OrganizationRequestEndpoints.init(this, kernelKey);
		SupportTicketEndpoints.init(this, kernelKey);

		await reconcileTicketBoards(
			{ projects: this.projects, issues: this.issues, logger: this.logger },
			kernelKey,
			(this.config?.private ?? {}) as TicketBoardsConfig
		);

		this.logger.logOk("ProjectManagerService iniciado");
	}

	/**
	 * Resuelve `userId` + `groupIds` del caller desde el token y cachea en `ctx`.
	 * Restringido a llamadas que posean la `kernelKey` del service (típicamente,
	 * los endpoints registrados vía `init(this, kernelKey)`).
	 */
	@OnlyKernel()
	async resolveCaller(_kernelKey: symbol, ctx: EndpointCtx): Promise<CallerMembership> {
		const cacheKey = Symbol.for("PMCallerMembership");
		const cached = (ctx as any)[cacheKey];
		if (cached) return cached;

		const userId = ctx.user?.id ?? "";
		const tokenOrgId = ctx.user?.orgId ?? null;
		let groupIds: string[] = [];
		if (userId) {
			try {
				const full = await this.identity.users.getUser(userId, ctx.token ?? undefined);
				groupIds = full?.groupIds ?? [];
			} catch {
				groupIds = [];
			}
		}
		const caller: CallerMembership = { userId, groupIds, tokenOrgId };
		Object.defineProperty(ctx, cacheKey, { value: caller, enumerable: false });
		return caller;
	}

	@OnlyKernel()
	async listProjectsForCaller(_kernelKey: symbol, ctx: EndpointCtx): Promise<Project[]> {
		const pmCtx = await this.buildPMCtx(_kernelKey, ctx);
		return this.projects.listVisibleProjects(pmCtx, ctx.token ?? undefined);
	}

	/**
	 * Construye el contexto PM del caller (roles, permisos globales, tokenOrgId,
	 * helper `isOrgAdminOrPM`). Cacheado en `ctx` para evitar relecturas.
	 *
	 * Válido para list / create / update / delete y reutilizable desde otros
	 * scopes (sprints/milestones/issues) cuando necesiten los flags de rol.
	 */
	@OnlyKernel()
	async buildPMCtx(_kernelKey: symbol, ctx: EndpointCtx): Promise<PMCtx> {
		const cacheKey = Symbol.for("PMCtx");
		const cached = (ctx as any)[cacheKey];
		if (cached) return cached;

		const caller = await this.resolveCaller(_kernelKey, ctx);
		const identity = this.#identity!;
		const internalRoles = this.#internalRoles!;
		const tokenOrgId = ctx.user?.orgId ?? null;
		const user = caller.userId ? await identity.users.getUser(caller.userId, ctx.token ?? undefined) : null;
		const [globalAdminRole, hasGlobalPMRead, hasGlobalPMWrite] = await Promise.all([
			hasGlobalAdminRole(internalRoles, user),
			identity.permissions.hasPermission(caller.userId, CRUDXAction.READ, PMScopes.PROJECTS),
			identity.permissions.hasPermission(caller.userId, CRUDXAction.WRITE, PMScopes.PROJECTS),
		]);
		const isGlobalAdmin = !tokenOrgId && globalAdminRole;

		// Memoizar `isOrgAdminOrPM` por orgId para no repetir lookup en una misma request.
		const orgRoleCache = new Map<string, Promise<boolean>>();

		const pmCtx: PMCtx = {
			userId: caller.userId,
			groupIds: caller.groupIds,
			tokenOrgId,
			isGlobalAdmin,
			hasGlobalPMRead,
			hasGlobalPMWrite,
			isOrgAdminOrPM: (orgId: string) => {
				let p = orgRoleCache.get(orgId);
				if (!p) {
					p = isOrgAdminOrPM(internalRoles, user, orgId);
					orgRoleCache.set(orgId, p);
				}
				return p;
			},
		};
		Object.defineProperty(ctx, cacheKey, { value: pmCtx, enumerable: false });
		return pmCtx;
	}

	get projects(): ProjectManager {
		if (!this.#projectManager) throw new Error("ProjectManager not initialized");
		return this.#projectManager;
	}
	get sprints(): SprintManager {
		if (!this.#sprintManager) throw new Error("SprintManager not initialized");
		return this.#sprintManager;
	}
	get milestones(): MilestoneManager {
		if (!this.#milestoneManager) throw new Error("MilestoneManager not initialized");
		return this.#milestoneManager;
	}
	get issues(): IssueManager {
		if (!this.#issueManager) throw new Error("IssueManager not initialized");
		return this.#issueManager;
	}

	/**
	 * Notificaciones de dominio de PM (issues, menciones, solicitudes de org).
	 * Gateado con `@OnlyKernel()`: el caller debe presentar la `kernelKey`, de modo
	 * que un módulo no confiable cargado en un kernel comprometido no pueda emitir
	 * ni spoofear notificaciones a usuarios arbitrarios.
	 */
	@OnlyKernel()
	notifications(_kernelKey: symbol): NotifyManager {
		if (!this.#notifyManager) throw new Error("NotifyManager not initialized");
		return this.#notifyManager;
	}

	/**
	 * Ruta de app de un proyecto (`/:orgSlug/:projectSlug`, o `/default/:slug` si es
	 * global) para enlazar notificaciones. El cliente la resuelve a puerto (dev) o
	 * subdominio (prod). Devuelve `/` (lista de proyectos) si no se puede resolver.
	 */
	async #projectPath(projectId: string): Promise<string> {
		const project = await this.#projectInternals?.fetchProject(projectId).catch(() => null);
		if (!project?.slug) return "/";
		const orgSlug = project.orgId ? (await this.#internalOrgs?.resolveOrganizationSlug(project.orgId).catch(() => null))?.slug : "default";
		return orgSlug ? `/${orgSlug}/${project.slug}` : "/";
	}
	get organizationRequests(): OrganizationRequestManager {
		if (!this.#organizationRequestManager) throw new Error("OrganizationRequestManager not initialized");
		return this.#organizationRequestManager;
	}
	get supportTickets(): SupportTicketManager {
		if (!this.#supportTicketManager) throw new Error("SupportTicketManager not initialized");
		return this.#supportTicketManager;
	}
	get identity(): IIdentityManagerService {
		if (!this.#identity) throw new Error("IdentityManagerService not initialized");
		return this.#identity;
	}

	get issueAttachments(): AttachmentsManager {
		if (!this.#issueAttachmentsManager)
			throw new ProjectManagerErrorRef(503, "ATTACHMENTS_UNAVAILABLE", "Attachments no disponibles (provider/utility no inicializado)");
		return this.#issueAttachmentsManager;
	}

	get issueComments(): CommentsManager {
		if (!this.#issueCommentsManager)
			throw new ProjectManagerErrorRef(503, "COMMENTS_UNAVAILABLE", "Comments no disponibles (provider/utility no inicializado)");
		return this.#issueCommentsManager;
	}

	get issueDescriptionDrafts(): DraftsRepository {
		if (!this.#issueDescriptionDrafts)
			throw new ProjectManagerErrorRef(
				503,
				"DESCRIPTION_DRAFTS_UNAVAILABLE",
				"Drafts de descripción no disponibles (mongo no inicializado)"
			);
		return this.#issueDescriptionDrafts;
	}

	@DisableEndpoints()
	async stop(kernelKey: symbol): Promise<void> {
		await super.stop(kernelKey);
		this.#authVerifier = null;
		this.logger.logOk("ProjectManagerService detenido");
	}

	/**
	 * Purga en cascada los datos PRIVADOS de un usuario tras expirar su retención
	 * (invocado por IIdentityManagerService). Borra SÓLO sus proyectos privados
	 * (`visibility=private`, `ownerId=userId`) y, en cascada, sus issues (con
	 * adjuntos y comentarios), sprints y milestones. Los tableros de organización
	 * a los que pertenezca quedan intactos (no se consultan aquí).
	 *
	 * Handshake cross‑módulo: el caller (IdentityManager) prueba scope `identity:internal`;
	 * PM purga con SU PROPIO token de ciclo de vida, no con el del caller.
	 */
	async purgeUserPrivateData(cap: CapabilityToken, userId: string): Promise<void> {
		assertScope(cap, Scope.IdentityInternal);
		const lifecycleKey = this.#lifecycleKey;
		if (!userId || !lifecycleKey) return;
		const removed = await purgePrivateProjectData(
			{
				projects: this.projects,
				issues: this.issues,
				sprints: this.sprints,
				milestones: this.milestones,
				comments: this.#issueCommentsManager,
				attachments: this.#issueAttachmentsManager,
				logger: this.logger,
			},
			lifecycleKey,
			userId
		);
		if (removed !== null) {
			this.logger.logInfo(`Purga PM: ${removed} proyecto(s) privado(s) del usuario ${userId} eliminados en cascada`);
		}
	}

	private async waitForMongo(): Promise<void> {
		const maxWaitTime = 10000;
		const startTime = Date.now();

		while (!this.mongoProvider.isConnected() && Date.now() - startTime < maxWaitTime) {
			await new Promise((resolve) => setTimeout(resolve, 500));
		}

		if (!this.mongoProvider.isConnected()) {
			throw new Error("MongoDB no pudo conectarse en el tiempo esperado");
		}
	}
}
