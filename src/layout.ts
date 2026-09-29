import * as vscode from 'vscode';
import { ORIENTATION_HORIZONTAL } from './core/layout';

export {
	LayoutPlan,
	MAX_VIEW_COLUMNS,
	PlacedFile,
	PositionCollision,
	ResolvedEntry,
	findCollisions,
	planLayout,
	resolvePositions
} from './core/layout';

/** Rebuilds the editor grid to match a plan produced by `planLayout`. Discards other open groups. */
export async function applyGridLayout(groups: unknown[]): Promise<void> {
	await vscode.commands.executeCommand('vscode.setEditorLayout', {
		orientation: ORIENTATION_HORIZONTAL,
		groups
	});
}
