import { AppWithSeo } from "@apps/AppWithSeo.js";

/**
 * ADC Project Manager App - Panel de gestión de proyectos tipo Jira
 */
export default class AdcProjectManagerApp extends AppWithSeo {
	async run(): Promise<void> {
		this.registerSeo({
			sitemap: { paths: [{ path: "/", changefreq: "monthly", priority: 0.6 }] },
			pageMeta: {
				defaults: {
					// `noindex` por defecto y sólo `/` lo revierte: cualquier ruta nueva de la app
					// nace fuera del índice sin que haya que acordarse de excluirla.
					robots: "noindex,nofollow",
					og: { siteName: "Abby's Digital Cafe" },
					ogBrand: { background: "#e5f4ff", color: "#263690", brandName: "ADC Projects" },
				},
				pages: [
					{
						path: "/",
						meta: {
							title: "Gestión de proyectos",
							titleTemplate: "%s · Abby's Digital Cafe",
							description: "Organizá equipos, sprints y entregas en Abby's Digital Cafe, sin planillas ni hilos sueltos.",
							robots: "index,follow",
						},
					},
				],
			},
		});
		this.logger.logOk("ADC Project Manager App iniciada");
	}
}
