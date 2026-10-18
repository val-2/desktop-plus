import { NoChanges } from '../../src/ui/changes/no-changes'
import type { IRepositoryState } from '../../src/lib/app-state'
import * as React from 'react'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { PushPullButton } from '../../src/ui/toolbar/push-pull-button'
import { Repository } from '../../src/models/repository'
import { TipState } from '../../src/models/tip'
import { ForcePushBranchState } from '../../src/lib/rebase'

// The same native component must render identically for local and SSH repos.
describe('SSH native toolbar parity', () => {
  const props: React.ComponentProps<typeof PushPullButton> = {
    repository: new Repository('ssh://test/repo', 1, null, false),
    aheadBehind: { ahead: 0, behind: 0 },
    remoteName: 'origin',
    networkActionInProgress: false,
    lastFetched: null,
    progress: null,
    dispatcher: {} as React.ComponentProps<typeof PushPullButton>['dispatcher'],
    tipState: TipState.Valid,
    rebaseInProgress: false,
    forcePushBranchState: ForcePushBranchState.NotAvailable,
    shouldNudge: false,
    numTagsToPush: 0,
    isDropdownOpen: false,
    askForConfirmationOnForcePush: true,
    enableFocusTrap: true,
    pushPullButtonWidth: { value: 200, min: 100, max: 500 },
    onDropdownStateChanged: () => {},
  }

  it('does not suggest publishing or a clean working tree before the SSH load completes', () => {
    const html = renderToStaticMarkup(
      <NoChanges
        repository={props.repository}
        repositoryState={
          { isPushPullFetchInProgress: true, remote: null } as IRepositoryState
        }
        dispatcher={props.dispatcher}
        appMenu={undefined}
        isExternalEditorAvailable={false}
      />
    )
    assert(html.includes('Loading repository'))
    assert(html.includes('spin'))
    assert(!html.includes('Publish'))
    assert(!html.includes('No local changes'))
  })

  for (const [state, overrides, expected] of [
    [
      'loading',
      {
        remoteName: null,
        networkActionInProgress: true,
        progress: { kind: 'generic', title: 'Loading repository', value: 0 },
      },
      'Loading repository',
    ],
    ['up to date', {}, 'Fetch origin'],
    ['behind', { aheadBehind: { ahead: 0, behind: 2 } }, 'Pull origin'],
    ['ahead', { aheadBehind: { ahead: 1, behind: 0 } }, 'Push origin'],
    [
      'fetching',
      {
        networkActionInProgress: true,
        progress: {
          kind: 'fetch',
          title: 'Fetching origin',
          value: 0.3,
          remote: 'origin',
        },
      },
      'Fetching origin',
    ],
  ] as const) {
    it(`matches the original toolbar when ${state}`, () => {
      const current = { ...props, ...overrides }
      const remote = renderToStaticMarkup(<PushPullButton {...current} />)
      const local = renderToStaticMarkup(
        <PushPullButton
          {...current}
          repository={new Repository('/tmp/repo', 2, null, false)}
        />
      )
      assert.equal(remote, local)
      assert(remote.includes(expected))
      if (state === 'loading') {
        assert(!remote.includes('Publish repository'))
        assert(remote.includes('spin'))
        assert(remote.includes('disabled'))
      }
      if (state === 'fetching') {
        assert(remote.includes('spin'))
        assert(remote.includes('disabled'))
        assert(remote.includes('scaleX(0.3)'))
      }
    })
  }
})
