package gitcheckout

import (
	"context"
	"fmt"
)

// ResolvedRevision is one selection resolved from the fetched mirror state.
type ResolvedRevision struct {
	Selection         Selection `json:"selection"`
	Commit            string    `json:"commit"`
	ObservedReference string    `json:"observedReference"`
	ObservedObject    string    `json:"observedObject"`
	TagObject         string    `json:"tagObject,omitempty"`
}

// ResolveRevision resolves one explicit branch, tag or commit against an already
// fetched managed mirror. Nothing is expanded: a branch resolves through the
// remote-tracking reference, a tag through its own object and then to the commit
// it points at, and a commit must resolve to itself.
func ResolveRevision(ctx context.Context, runner *Runner, executable Executable, context ExecutionContext, paths InstallationPaths, remote NamedRemote, selection Selection) (ResolvedRevision, error) {
	if err := AssertSelection(selection); err != nil {
		return ResolvedRevision{}, err
	}
	if err := AssertNamedRemote(remote); err != nil {
		return ResolvedRevision{}, err
	}
	if err := AssertManagedTarget(paths, paths.MirrorPath, "Managed Git mirror"); err != nil {
		return ResolvedRevision{}, err
	}
	if err := VerifyBareMirror(ctx, runner, executable, context, paths.MirrorPath, remote); err != nil {
		return ResolvedRevision{}, err
	}
	switch selection.Kind {
	case SelectionBranch:
		reference := "refs/remotes/" + remote.Name + "/" + selection.Branch
		commit, err := resolveCommitExpression(ctx, runner, executable, context, paths.MirrorPath, reference+"^{commit}", "Branch")
		if err != nil {
			return ResolvedRevision{}, err
		}
		return ResolvedRevision{Selection: selection, Commit: commit, ObservedReference: reference, ObservedObject: commit}, nil
	case SelectionTag:
		reference := "refs/tags/" + selection.Tag
		tagObject, err := resolveObjectExpression(ctx, runner, executable, context, paths.MirrorPath, reference, "Tag")
		if err != nil {
			return ResolvedRevision{}, err
		}
		commit, err := resolveCommitExpression(ctx, runner, executable, context, paths.MirrorPath, reference+"^{commit}", "Tag")
		if err != nil {
			return ResolvedRevision{}, err
		}
		return ResolvedRevision{Selection: selection, Commit: commit, ObservedReference: reference, ObservedObject: tagObject, TagObject: tagObject}, nil
	}
	commit, err := resolveCommitExpression(ctx, runner, executable, context, paths.MirrorPath, selection.Commit+"^{commit}", "Commit")
	if err != nil {
		return ResolvedRevision{}, err
	}
	if commit != selection.Commit {
		return ResolvedRevision{}, fmt.Errorf("%w: Requested commit did not resolve to its exact identity.", ErrRefNotCommit)
	}
	return ResolvedRevision{Selection: selection, Commit: commit, ObservedReference: selection.Commit, ObservedObject: commit}, nil
}

// AssertReferenceNotRewritten detects a branch that no longer descends from the commit
// it was observed at, or a tag that now points somewhere else, before anything is
// activated from it. A mutable reference moving is not something the launcher may
// resolve by itself: it is a decision the operator has to make again.
func AssertReferenceNotRewritten(ctx context.Context, runner *Runner, executable Executable, context ExecutionContext, paths InstallationPaths, previous ReferenceObservation, current ResolvedRevision) error {
	if previous.Selection.Kind != current.Selection.Kind || !SameSelection(previous.Selection, current.Selection) {
		return fmt.Errorf("%w: Reference rewrite comparison requires the same selected reference.", ErrRefInvalid)
	}
	if err := AssertManagedTarget(paths, paths.MirrorPath, "Managed Git mirror"); err != nil {
		return err
	}
	if current.Selection.Kind == SelectionTag {
		if previous.Commit != current.Commit {
			return fmt.Errorf("%w: Tracked tag now resolves to a different commit (was %s, now %s).", ErrRefRewritten, previous.Commit, current.Commit)
		}
		return nil
	}
	result, err := runner.Run(ctx, executable, context, Command{
		Operation: "git.verify_branch_descends",
		Arguments: []string{"--git-dir", paths.MirrorPath, "merge-base", "--is-ancestor", previous.Commit, current.Commit},
	})
	if err != nil {
		return err
	}
	descends, err := IsGitAncestryResult(result)
	if err != nil {
		return err
	}
	if !descends {
		return fmt.Errorf("%w: Tracked branch no longer descends from its previous commit (was %s, now %s).", ErrRefRewritten, previous.Commit, current.Commit)
	}
	return nil
}

func resolveCommitExpression(ctx context.Context, runner *Runner, executable Executable, context ExecutionContext, mirrorPath, expression, subject string) (string, error) {
	result, err := runner.Run(ctx, executable, context, Command{
		Operation: "git.resolve_reference_commit",
		Arguments: []string{"--git-dir", mirrorPath, "rev-parse", "--verify", "--end-of-options", expression},
	})
	if err != nil {
		return "", err
	}
	resolved, err := RequireGitReferenceCommand(result, subject)
	if err != nil {
		return "", err
	}
	line, err := RequireSingleGitLine(resolved.Stdout, subject+" commit")
	if err != nil {
		return "", err
	}
	return ParseCommitSHA(line)
}

func resolveObjectExpression(ctx context.Context, runner *Runner, executable Executable, context ExecutionContext, mirrorPath, expression, subject string) (string, error) {
	result, err := runner.Run(ctx, executable, context, Command{
		Operation: "git.resolve_reference_object",
		Arguments: []string{"--git-dir", mirrorPath, "rev-parse", "--verify", "--end-of-options", expression},
	})
	if err != nil {
		return "", err
	}
	resolved, err := RequireGitReferenceCommand(result, subject)
	if err != nil {
		return "", err
	}
	line, err := RequireSingleGitLine(resolved.Stdout, subject+" object")
	if err != nil {
		return "", err
	}
	return ParseCommitSHA(line)
}
