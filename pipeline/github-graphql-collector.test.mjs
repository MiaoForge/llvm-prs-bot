import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createGitHubGraphQLCollector } from './github-graphql-collector.mjs'
import { triagePr } from './pr-triage.mjs'

const headSha = '1'.repeat(40)
const now = '2026-11-27T12:00:00Z'

test('collects Clang/Lex and whole-repo PRs, issues, and reviewer history via batched GraphQL', async () => {
  const queries = []
  const collector = createGitHubGraphQLCollector({
    token: 'test-token',
    maxPulls: 10,
    maxIssues: 10,
    maxHistory: 5,
    async fetchImpl(_url, request) {
      assert.equal(request.method, 'POST')
      assert.equal(request.headers.Authorization, 'Bearer test-token')
      const { variables } = JSON.parse(request.body)
      queries.push(variables.query)
      if (variables.query.includes('is:pr is:open')) {
        return Response.json({
          data: {
            search: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  number: 1001,
                  title: '[clang][Lex] Fix raw string literal lexing',
                  url: 'https://github.com/llvm/llvm-project/pull/1001',
                  state: 'OPEN',
                  createdAt: '2026-11-20T00:00:00Z',
                  updatedAt: '2026-11-27T00:00:00Z',
                  mergeable: 'MERGEABLE',
                  headRefOid: headSha,
                  baseRefName: 'main',
                  author: { __typename: 'User', login: 'lex-author' },
                  labels: { nodes: [{ name: 'clang:frontend' }] },
                  files: {
                    pageInfo: { hasNextPage: false },
                    nodes: [{ path: 'clang/lib/Lex/Lexer.cpp' }],
                  },
                  reviews: { pageInfo: { hasPreviousPage: false }, nodes: [] },
                  reviewRequests: { nodes: [] },
                  comments: { pageInfo: { hasPreviousPage: false }, nodes: [] },
                  reviewThreads: { nodes: [] },
                  commits: {
                    totalCount: 1,
                    nodes: [
                      {
                        commit: {
                          oid: headSha,
                          commitUrl: `https://github.com/llvm/llvm-project/commit/${headSha}`,
                          committedDate: '2026-11-20T00:00:00Z',
                          committer: { user: { __typename: 'User', login: 'lex-author' } },
                          statusCheckRollup: {
                            contexts: {
                              pageInfo: { hasNextPage: false },
                              nodes: [
                                {
                                  __typename: 'CheckRun',
                                  name: 'clang-check',
                                  status: 'COMPLETED',
                                  conclusion: 'SUCCESS',
                                  detailsUrl: 'https://github.com/llvm/llvm-project/runs/1',
                                },
                              ],
                            },
                          },
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
        })
      }
      if (variables.query.includes('is:issue is:open')) {
        return Response.json({
          data: {
            search: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  number: 2001,
                  title: '[clang][Lex] Preprocessor macro expansion bug',
                  body: '```cpp\n#define FOO 1\nint x = FOO;\n```\nExpected: accepts.',
                  url: 'https://github.com/llvm/llvm-project/issues/2001',
                  state: 'OPEN',
                  createdAt: '2026-11-10T00:00:00Z',
                  updatedAt: '2026-11-27T00:00:00Z',
                  author: { __typename: 'User', login: 'reporter' },
                  labels: { nodes: [{ name: 'clang:frontend' }] },
                  comments: { pageInfo: { hasPreviousPage: false }, nodes: [] },
                },
              ],
            },
          },
        })
      }
      return Response.json({
        data: {
          search: {
            nodes: [
              {
                number: 999,
                url: 'https://github.com/llvm/llvm-project/pull/999',
                author: { login: 'someone' },
                labels: { nodes: [{ name: 'clang:frontend' }] },
                files: { nodes: [{ path: 'clang/lib/Lex/Lexer.cpp' }] },
                reviews: {
                  nodes: [
                    {
                      state: 'APPROVED',
                      submittedAt: '2026-11-25T00:00:00Z',
                      url: 'https://github.com/llvm/llvm-project/pull/999#pullrequestreview-1',
                      author: { __typename: 'User', login: 'lex-maintainer' },
                      commit: { oid: headSha },
                    },
                  ],
                },
              },
            ],
          },
        },
      })
    },
  })

  const observations = await collector.collect(now)
  assert.equal(observations.prs.length, 1)
  assert.equal(observations.issues.length, 1)
  assert.equal(observations.reviewerHistory.length, 1)
  assert.ok(observations.issues[0].moduleIds.includes('clang-lex'))
  const triaged = triagePr(observations.prs[0], {
    now,
    reviewerHistory: observations.reviewerHistory,
  })
  assert.ok(triaged.moduleIds.includes('clang-lex'))
  assert.equal(triaged.headCi.status, 'passing')
  assert.equal(triaged.suggestedReviewers[0]?.login, 'lex-maintainer')
  assert.ok(queries.some((q) => q.includes('clang/lib/Lex')))
})
