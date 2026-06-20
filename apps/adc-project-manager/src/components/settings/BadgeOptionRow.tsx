import { useTranslation } from "@ui-library/utils/i18n-react";
import type { BadgeOption } from "@common/types/project-manager/CustomField.ts";
import { LABEL_COLORS } from "@common/types/project-manager/LabelColors.ts";

interface Props {
	option: BadgeOption;
	disabled?: boolean;
	onName: (name: string) => void;
	onColor: (color: BadgeOption["color"]) => void;
	onRemove: () => void;
}

/** Editor de una única opción coloreada de un custom field `badge`. */
export function BadgeOptionRow({ option, disabled, onName, onColor, onRemove }: Readonly<Props>) {
	const { t } = useTranslation({ namespace: "adc-project-manager" });
	return (
		<li className="flex items-center gap-2 p-1.5 border border-border rounded-md bg-surface">
			<adc-input value={option.name} onInput={(e: any) => onName(e.target.value)} disabled={disabled} />
			<div className="flex flex-wrap gap-1">
				{LABEL_COLORS.map((c) => (
					<button
						key={c}
						type="button"
						disabled={disabled}
						onClick={() => onColor(c)}
						className={`rounded-full ${option.color === c ? "ring-2 ring-primary" : ""}`}
					>
						<adc-color-label color={c} size="xs">
							{c}
						</adc-color-label>
					</button>
				))}
			</div>
			<button
				type="button"
				onClick={onRemove}
				disabled={disabled}
				className="ml-auto text-tdanger font-bold text-sm disabled:opacity-30"
				aria-label={t("common.delete")}
			>
				x
			</button>
		</li>
	);
}
