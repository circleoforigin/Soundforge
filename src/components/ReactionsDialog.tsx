import { useState } from 'react';

import type {
  ConditionOperator,
  EventFieldDefinition,
  ReactionCondition,
  RegisteredEventDefinition,
} from '@settingforge/module-sdk';

import type {
  SacscapeReaction,
} from '../models/SacscapeReaction';

export interface ReactionSceneOption {
  id: string;
  name: string;
}

interface ReactionsDialogProps {
  reactions: SacscapeReaction[];
  events: RegisteredEventDefinition[];
  scenes: ReactionSceneOption[];
  onChange: (
    reactions: SacscapeReaction[]
  ) => void;
  onClose: () => void;
}

const STRING_OPERATORS:
  ConditionOperator[] = [
    'equals',
    'notEquals',
    'contains',
    'notContains',
  ];

const NUMBER_OPERATORS:
  ConditionOperator[] = [
    'equals',
    'notEquals',
    'greaterThan',
    'greaterThanOrEqual',
    'lessThan',
    'lessThanOrEqual',
  ];

const BOOLEAN_OPERATORS:
  ConditionOperator[] = [
    'equals',
    'notEquals',
    'isTrue',
    'isFalse',
  ];

const OPERATOR_LABELS:
  Record<
    ConditionOperator,
    string
  > = {
    equals: 'Equals',
    notEquals: 'Not Equals',
    contains: 'Contains',
    notContains: 'Not Contains',
    greaterThan: 'Greater Than',
    greaterThanOrEqual:
      'Greater Than or Equal',
    lessThan: 'Less Than',
    lessThanOrEqual:
      'Less Than or Equal',
    isTrue: 'Is True',
    isFalse: 'Is False',
  };

function operatorsFor(
  field?: EventFieldDefinition
): ConditionOperator[] {
  if (
    field?.type === 'number'
  ) {
    return NUMBER_OPERATORS;
  }

  if (
    field?.type === 'boolean'
  ) {
    return BOOLEAN_OPERATORS;
  }

  return STRING_OPERATORS;
}

function defaultValue(
  field?: EventFieldDefinition
) {
  if (
    field?.type === 'number'
  ) {
    return 0;
  }

  if (
    field?.type === 'boolean'
  ) {
    return false;
  }

  return '';
}

function cloneReaction(
  reaction: SacscapeReaction
): SacscapeReaction {
  return {
    ...reaction,

    trigger: {
      ...reaction.trigger,

      conditions:
        reaction.trigger.conditions.map(
          (condition) => ({
            ...condition,
          })
        ),
    },

    effect: {
      ...reaction.effect,
    },
  };
}

export default function ReactionsDialog({
  reactions,
  events,
  scenes,
  onChange,
  onClose,
}: ReactionsDialogProps) {
  const [
    draft,
    setDraft,
  ] =
    useState<SacscapeReaction | null>(
      null
    );

  const [
    error,
    setError,
  ] =
    useState('');

  const selectedEvent =
    events.find(
      (event) =>
        event.id ===
        draft?.trigger.triggerEventId
    );

  function startAdd() {
    const reactionId =
      crypto.randomUUID();

    setDraft({
      id: reactionId,

      trigger: {
        id:
          crypto.randomUUID(),

        triggerEventId:
          events[0]?.id ?? '',

        conditions: [],
      },

      effect: {
        type: 'load-scene',

        sceneId:
          scenes[0]?.id ?? '',
      },
    });

    setError('');
  }

  function updateCondition(
    index: number,
    condition:
      ReactionCondition
  ) {
    if (!draft) {
      return;
    }

    const conditions =
      draft.trigger.conditions.map(
        (
          candidate,
          position
        ) =>
          position === index
            ? condition
            : candidate
      );

    setDraft({
      ...draft,

      trigger: {
        ...draft.trigger,
        conditions,
      },
    });
  }

  function addCondition() {
    if (!draft) {
      return;
    }

    const field =
      selectedEvent
        ?.fields?.[0];

    if (!field) {
      return;
    }

    const operator =
      operatorsFor(field)[0];

    setDraft({
      ...draft,

      trigger: {
        ...draft.trigger,

        conditions: [
          ...draft.trigger.conditions,

          {
            field:
              field.key,

            operator,

            value:
              defaultValue(
                field
              ),
          },
        ],
      },
    });
  }

  function saveDraft() {
    if (!draft) {
      return;
    }

    if (
      !draft.effect.sceneId
    ) {
      setError(
        'Choose a Scene.'
      );

      return;
    }

    if (
      !draft.trigger
        .triggerEventId
    ) {
      setError(
        'Choose a trigger Event.'
      );

      return;
    }

    const trimmedName =
      draft.name?.trim();

    const saved = {
      ...cloneReaction(
        draft
      ),

      name:
        trimmedName ||
        undefined,
    };

    const exists =
      reactions.some(
        (reaction) =>
          reaction.id ===
          saved.id
      );

    onChange(
      exists
        ? reactions.map(
            (reaction) =>
              reaction.id ===
              saved.id
                ? saved
                : reaction
          )
        : [
            ...reactions,
            saved,
          ]
    );

    setDraft(null);
    setError('');
  }

  function deleteReaction(
    reaction:
      SacscapeReaction
  ) {
    const label =
      reaction.name ||
      'this Reaction';

    if (
      !window.confirm(
        `Delete "${label}"?`
      )
    ) {
      return;
    }

    onChange(
      reactions.filter(
        (candidate) =>
          candidate.id !==
          reaction.id
      )
    );
  }

  function describeReaction(
    reaction:
      SacscapeReaction
  ) {
    const scene =
      scenes.find(
        (candidate) =>
          candidate.id ===
          reaction.effect.sceneId
      );

    const event =
      events.find(
        (candidate) =>
          candidate.id ===
          reaction.trigger
            .triggerEventId
      );

    const effectSummary =
      `Load Scene: ${
        scene?.name ??
        'Missing Scene'
      }`;

    const eventSummary =
      event
        ? `${event.moduleName} — ${event.label}`
        : reaction.trigger
              .triggerEventId ||
          'Missing Event';

    const conditions =
      reaction.trigger.conditions.map(
        (condition) => {
          const field =
            event?.fields?.find(
              (candidate) =>
                candidate.key ===
                condition.field
            );

          const operator =
            OPERATOR_LABELS[
              condition.operator
            ];

          const value =
            condition.value ===
            undefined
              ? ''
              : ` ${String(
                  condition.value
                )}`;

          return (
            `${
              field?.label ??
              condition.field
            } ${operator}${value}`
          );
        }
      );

    return {
      effectSummary,
      eventSummary,
      conditions,
    };
  }

  return (
    <div className="dialog-backdrop">
      <div className="dialog reactions-dialog">
        <header className="reactions-dialog-header">
          <h2>
            Reactions
          </h2>

          <button
            type="button"
            onClick={onClose}
          >
            Close
          </button>
        </header>

        {!draft && (
          <>
            <div className="reactions-list">
              {reactions.length ===
                0 && (
                <p className="reactions-empty">
                  No Reactions
                  configured.
                </p>
              )}

              {reactions.map(
                (reaction) => {
                  const summary =
                    describeReaction(
                      reaction
                    );

                  return (
                    <article
                      key={
                        reaction.id
                      }
                      className="reaction-item"
                    >
                      {reaction.name && (
                        <strong>
                          {
                            reaction.name
                          }
                        </strong>
                      )}

                      <span>
                        {
                          summary.effectSummary
                        }
                      </span>

                      <span>
                        When{' '}
                        {
                          summary.eventSummary
                        }
                      </span>

                      {summary.conditions.map(
                        (
                          condition,
                          index
                        ) => (
                          <small
                            key={`${reaction.id}:${index}`}
                          >
                            {index >
                            0
                              ? 'AND '
                              : ''}
                            {
                              condition
                            }
                          </small>
                        )
                      )}

                      <div className="reaction-item-actions">
                        <button
                          type="button"
                          onClick={() =>
                            setDraft(
                              cloneReaction(
                                reaction
                              )
                            )
                          }
                        >
                          Edit
                        </button>

                        <button
                          type="button"
                          onClick={() =>
                            deleteReaction(
                              reaction
                            )
                          }
                        >
                          Delete
                        </button>
                      </div>
                    </article>
                  );
                }
              )}
            </div>

            <div className="dialog-buttons">
              <button
                type="button"
                onClick={
                  startAdd
                }
              >
                Add Reaction
              </button>
            </div>
          </>
        )}

        {draft && (
          <div className="reaction-editor">
            <label>
              Name (optional)

              <input
                value={
                  draft.name ??
                  ''
                }
                onChange={(
                  event
                ) =>
                  setDraft({
                    ...draft,

                    name:
                      event
                        .target
                        .value,
                  })
                }
              />
            </label>

            <label>
              Effect

              <select
                value="load-scene"
                disabled
              >
                <option value="load-scene">
                  Load Scene
                </option>
              </select>
            </label>

            <label>
              Scene

              <select
                value={
                  draft.effect
                    .sceneId
                }
                onChange={(
                  event
                ) =>
                  setDraft({
                    ...draft,

                    effect: {
                      type:
                        'load-scene',

                      sceneId:
                        event
                          .target
                          .value,
                    },
                  })
                }
              >
                {!scenes.some(
                  (scene) =>
                    scene.id ===
                    draft.effect
                      .sceneId
                ) && (
                  <option
                    value={
                      draft
                        .effect
                        .sceneId
                    }
                  >
                    Missing Scene
                  </option>
                )}

                {scenes.map(
                  (scene) => (
                    <option
                      key={
                        scene.id
                      }
                      value={
                        scene.id
                      }
                    >
                      {
                        scene.name
                      }
                    </option>
                  )
                )}
              </select>
            </label>

            <label>
              Trigger Event

              <select
                value={
                  draft.trigger
                    .triggerEventId
                }
                onChange={(
                  event
                ) =>
                  setDraft({
                    ...draft,

                    trigger: {
                      ...draft.trigger,

                      triggerEventId:
                        event
                          .target
                          .value,

                      conditions:
                        [],
                    },
                  })
                }
              >
                {!events.some(
                  (candidate) =>
                    candidate.id ===
                    draft.trigger
                      .triggerEventId
                ) &&
                  draft.trigger
                    .triggerEventId && (
                    <option
                      value={
                        draft
                          .trigger
                          .triggerEventId
                      }
                    >
                      Missing Event
                    </option>
                  )}

                {events.length ===
                  0 && (
                  <option value="">
                    No Events
                    Available
                  </option>
                )}

                {events.map(
                  (candidate) => (
                    <option
                      key={`${candidate.moduleId}:${candidate.id}`}
                      value={
                        candidate.id
                      }
                    >
                      {
                        candidate.moduleName
                      }{' '}
                      —{' '}
                      {
                        candidate.label
                      }
                    </option>
                  )
                )}
              </select>
            </label>

            <section className="reaction-conditions">
              <div className="reaction-conditions-header">
                <h3>
                  Conditions
                </h3>

                <button
                  type="button"
                  disabled={
                    !selectedEvent
                      ?.fields
                      ?.length
                  }
                  onClick={
                    addCondition
                  }
                >
                  Add Condition
                </button>
              </div>

              {draft.trigger
                .conditions
                .length === 0 && (
                <p className="reactions-empty">
                  Runs whenever
                  this Event
                  occurs.
                </p>
              )}

              {draft.trigger.conditions.map(
                (
                  condition,
                  index
                ) => {
                  const field =
                    selectedEvent
                      ?.fields
                      ?.find(
                        (
                          candidate
                        ) =>
                          candidate.key ===
                          condition.field
                      );

                  const operators =
                    operatorsFor(
                      field
                    );

                  const noValue =
                    condition.operator ===
                      'isTrue' ||
                    condition.operator ===
                      'isFalse';

                  return (
                    <div
                      key={`${draft.id}:${index}`}
                      className="reaction-condition-row"
                    >
                      <select
                        aria-label="Condition field"
                        value={
                          condition.field
                        }
                        onChange={(
                          event
                        ) => {
                          const nextField =
                            selectedEvent
                              ?.fields
                              ?.find(
                                (
                                  candidate
                                ) =>
                                  candidate.key ===
                                  event
                                    .target
                                    .value
                              );

                          updateCondition(
                            index,
                            {
                              field:
                                event
                                  .target
                                  .value,

                              operator:
                                operatorsFor(
                                  nextField
                                )[0],

                              value:
                                defaultValue(
                                  nextField
                                ),
                            }
                          );
                        }}
                      >
                        {!field && (
                          <option
                            value={
                              condition.field
                            }
                          >
                            Missing
                            Field
                          </option>
                        )}

                        {selectedEvent
                          ?.fields
                          ?.map(
                            (
                              candidate
                            ) => (
                              <option
                                key={
                                  candidate.key
                                }
                                value={
                                  candidate.key
                                }
                              >
                                {
                                  candidate.label
                                }
                              </option>
                            )
                          )}
                      </select>

                      <select
                        aria-label="Condition operator"
                        value={
                          condition.operator
                        }
                        onChange={(
                          event
                        ) => {
                          const operator =
                            event
                              .target
                              .value as
                              ConditionOperator;

                          updateCondition(
                            index,
                            {
                              ...condition,

                              operator,

                              value:
                                operator ===
                                  'isTrue' ||
                                operator ===
                                  'isFalse'
                                  ? undefined
                                  : defaultValue(
                                      field
                                    ),
                            }
                          );
                        }}
                      >
                        {operators.map(
                          (
                            operator
                          ) => (
                            <option
                              key={
                                operator
                              }
                              value={
                                operator
                              }
                            >
                              {
                                OPERATOR_LABELS[
                                  operator
                                ]
                              }
                            </option>
                          )
                        )}
                      </select>

                      {!noValue &&
                        field?.type ===
                          'string' && (
                          <input
                            aria-label="Condition value"
                            value={
                              typeof condition.value ===
                              'string'
                                ? condition.value
                                : ''
                            }
                            onChange={(
                              event
                            ) =>
                              updateCondition(
                                index,
                                {
                                  ...condition,

                                  value:
                                    event
                                      .target
                                      .value,
                                }
                              )
                            }
                          />
                        )}

                      {!noValue &&
                        field?.type ===
                          'number' && (
                          <input
                            aria-label="Condition value"
                            type="number"
                            value={
                              typeof condition.value ===
                              'number'
                                ? condition.value
                                : 0
                            }
                            onChange={(
                              event
                            ) =>
                              updateCondition(
                                index,
                                {
                                  ...condition,

                                  value:
                                    Number(
                                      event
                                        .target
                                        .value
                                    ),
                                }
                              )
                            }
                          />
                        )}

                      {!noValue &&
                        field?.type ===
                          'boolean' && (
                          <select
                            aria-label="Condition value"
                            value={
                              condition.value ===
                              true
                                ? 'true'
                                : 'false'
                            }
                            onChange={(
                              event
                            ) =>
                              updateCondition(
                                index,
                                {
                                  ...condition,

                                  value:
                                    event
                                      .target
                                      .value ===
                                    'true',
                                }
                              )
                            }
                          >
                            <option value="true">
                              True
                            </option>

                            <option value="false">
                              False
                            </option>
                          </select>
                        )}

                      <button
                        type="button"
                        onClick={() =>
                          setDraft({
                            ...draft,

                            trigger: {
                              ...draft.trigger,

                              conditions:
                                draft.trigger.conditions.filter(
                                  (
                                    _,
                                    position
                                  ) =>
                                    position !==
                                    index
                                ),
                            },
                          })
                        }
                      >
                        Remove
                      </button>
                    </div>
                  );
                }
              )}
            </section>

            {error && (
              <p className="reaction-error">
                {error}
              </p>
            )}

            <div className="dialog-buttons">
              <button
                type="button"
                onClick={() =>
                  setDraft(
                    null
                  )
                }
              >
                Cancel
              </button>

              <button
                type="button"
                onClick={
                  saveDraft
                }
              >
                Save Reaction
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}