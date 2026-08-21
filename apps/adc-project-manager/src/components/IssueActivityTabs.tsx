import { useState, useEffect } from "react";
import { useTranslation } from "@ui-library/utils/i18n-react";
import type { UpdateLogEntry } from "@common/types/project-manager/UpdateLogEntry.ts";
import type { CallerCtx } from "../utils/permissions.ts";
import { pmApi } from "../utils/pm-api.ts";
import { IssueComments } from "./IssueComments.tsx";

interface Props {
	issueId: string;
	caller?: CallerCtx;
}

/** Tabs inferiores del diálogo de issue: Comentarios (default) | Historial. */
export function IssueActivityTabs({ issueId, caller }: Readonly<Props>) {
	const { t } = useTranslation({ namespace: "adc-project-manager" });
	const [tab, setTab] = useState<"comments" | "history">("comments");
	const [history, setHistory] = useState<UpdateLogEntry[]>([]);

	useEffect(() => {
		pmApi.getIssueHistory(issueId).then((r) => {
			if (r.success && r.data) setHistory(r.data.updateLog);
		});
	}, [issueId]);

	return (
		<div className="pt-2">
			<div className="flex gap-2 border-b border-divider">
				<button
					type="button"
					className={`px-3 py-1.5 text-sm border-b-2 -mb-px ${tab === "comments" ? "border-primary text-text" : "border-transparent text-muted"}`}
					onClick={() => setTab("comments")}
				>
					{t("issues.comments") ?? "Comentarios"}
				</button>
				<button
					type="button"
					className={`px-3 py-1.5 text-sm border-b-2 -mb-px ${tab === "history" ? "border-primary text-text" : "border-transparent text-muted"}`}
					onClick={() => setTab("history")}
				>
					{t("issues.history")} ({history.length})
				</button>
			</div>
			<div className="pt-3">
				{tab === "comments" ? (
					<IssueComments issueId={issueId} caller={caller} />
				) : (
					<ul className="rounded p-2 max-h-80 overflow-auto text-xs space-y-1">
						{history.map((h, idx) => (
							<li key={"history-" + idx} className="border-b border-text/15 pb-1">
								<span className="font-mono text-muted">{new Date(h.at).toLocaleString()}</span>{" "}
								<span className="font-semibold">{h.field}</span>:{" "}
								<span className="text-muted">{JSON.stringify(h.oldValue)}</span> →{" "}
								<span>{JSON.stringify(h.newValue)}</span>
								{h.reason && <span className="block text-muted italic">“{h.reason}”</span>}
							</li>
						))}
						{history.length === 0 && <li className="text-muted">—</li>}
					</ul>
				)}
			</div>
		</div>
	);
}
