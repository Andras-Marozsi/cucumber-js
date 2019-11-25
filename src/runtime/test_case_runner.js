import _ from 'lodash'
import { getAmbiguousStepException } from './helpers'
import AttachmentManager from './attachment_manager'
import Promise from 'bluebird'
import Status from '../status'
import StepRunner from './step_runner'

export default class TestCaseRunner {
  constructor({
    eventBroadcaster,
    retries = 0,
    skip,
    testCase,
    supportCodeLibrary,
    worldParameters,
  }) {
    const attachmentManager = new AttachmentManager(({ data, media }) => {
      if (this.testStepIndex > this.maxTestStepIndex) {
        throw new Error(
          'Cannot attach after all steps/hooks have finished running. Ensure your step/hook waits for the attach to finish.'
        )
      }
      this.emit('test-step-attachment', {
        index: this.testStepIndex,
        data,
        media,
      })
    })
    this.eventBroadcaster = eventBroadcaster
    this.maxAttempts = 1 + (skip ? 0 : retries)
    this.skip = skip
    this.testCase = testCase
    this.supportCodeLibrary = supportCodeLibrary
    this.world = new supportCodeLibrary.World({
      attach: ::attachmentManager.create,
      parameters: worldParameters,
    })
    this.beforeStepHookDefinitions = this.getBeforeStepHookDefinitions()
    this.afterStepHookDefinitions = this.getAfterStepHookDefinitions()
    this.beforeHookDefinitions = this.getBeforeHookDefinitions()
    this.afterHookDefinitions = this.getAfterHookDefinitions()
    this.maxTestStepIndex =
      this.beforeHookDefinitions.length +
      this.testCase.pickle.steps.length +
      this.afterHookDefinitions.length -
      1
    this.testCaseSourceLocation = {
      uri: this.testCase.uri,
      line: this.testCase.pickle.locations[0].line,
    }
    this.resetTestProgressData()
  }

  resetTestProgressData() {
    this.testStepIndex = 0
    this.result = {
      duration: 0,
      status: this.skip ? Status.SKIPPED : Status.PASSED,
    }
  }

  emit(name, data) {
    const eventData = { ...data }
    const testCaseData = {
      sourceLocation: this.testCaseSourceLocation,
    }
    if (this.currentAttemptNumber) {
      testCaseData.attemptNumber = this.currentAttemptNumber
    }
    if (_.startsWith(name, 'test-case')) {
      _.merge(eventData, testCaseData)
    } else {
      eventData.testCase = testCaseData
    }
    this.eventBroadcaster.emit(name, eventData)
  }

  emitPrepared() {
    const steps = []
    this.beforeHookDefinitions.forEach(definition => {
      const actionLocation = { uri: definition.uri, line: definition.line }
      steps.push({ actionLocation })
    })
    this.testCase.pickle.steps.forEach(step => {
      const actionLocations = this.getStepDefinitions(step).map(definition => ({
        uri: definition.uri,
        line: definition.line,
      }))
      const sourceLocation = {
        uri: this.testCase.uri,
        line: _.last(step.locations).line,
      }
      const data = { sourceLocation }
      if (actionLocations.length === 1) {
        data.actionLocation = actionLocations[0]
      }
      steps.push(data)
    })
    this.afterHookDefinitions.forEach(definition => {
      const actionLocation = { uri: definition.uri, line: definition.line }
      steps.push({ actionLocation })
    })
    this.emit('test-case-prepared', { steps })
  }

  getAfterHookDefinitions() {
    return this.supportCodeLibrary.afterTestCaseHookDefinitions.filter(
      hookDefinition => hookDefinition.appliesToTestCase(this.testCase)
    )
  }

  getBeforeHookDefinitions() {
    return this.supportCodeLibrary.beforeTestCaseHookDefinitions.filter(
      hookDefinition => hookDefinition.appliesToTestCase(this.testCase)
    )
  }

  getBeforeStepHookDefinitions() {
    return this.supportCodeLibrary.beforeTestStepHookDefinitions.filter(
      hookDefinition => hookDefinition.appliesToTestCase(this.testCase)
    )
  }

  getAfterStepHookDefinitions() {
    return this.supportCodeLibrary.afterTestStepHookDefinitions.filter(
      hookDefinition => hookDefinition.appliesToTestCase(this.testCase)
    )
  }

  getStepDefinitions(step) {
    return this.supportCodeLibrary.stepDefinitions.filter(stepDefinition =>
      stepDefinition.matchesStepName(step.text)
    )
  }

  invokeStep(step, stepDefinition, hookParameter) {
    return StepRunner.run({
      defaultTimeout: this.supportCodeLibrary.defaultTimeout,
      hookParameter,
      step,
      stepDefinition,
      world: this.world,
    })
  }

  isSkippingSteps() {
    return this.result.status !== Status.PASSED
  }

  shouldSkipHook(isBeforeHook) {
    return this.skip || (this.isSkippingSteps() && isBeforeHook)
  }

  shouldUpdateStatus(testStepResult) {
    switch (testStepResult.status) {
      case Status.UNDEFINED:
      case Status.FAILED:
      case Status.AMBIGUOUS:
        return !_.some(
          [Status.FAILED, Status.AMBIGUOUS, Status.UNDEFINED],
          this.result.status
        )
      default:
        return this.result.status === Status.PASSED
    }
  }

  startStep() {
    this.emit('test-step-started', { index: this.testStepIndex })
  }

  finishStep(testStepResult) {
    if (testStepResult.duration) {
      this.result.duration += testStepResult.duration
    }
    if (this.shouldUpdateStatus(testStepResult)) {
      this.result.status = testStepResult.status
    }
    if (testStepResult.exception) {
      this.result.exception = testStepResult.exception
    }
    this.emit('test-step-finished', {
      index: this.testStepIndex,
      result: testStepResult,
    })
    this.testStepIndex += 1
  }

  async aroundTestHook(runStepFn) {
    this.startStep()
    const testStepResult = await runStepFn()
    this.finishStep(testStepResult)
  }

  async aroundTestStep(runStepFn, step = null) {
    this.startStep()
    let stepAfterHooksResult
    let testStepResult
    const stepBeforeHooksResult = await this.runStepHooks(step, true)
    if (stepBeforeHooksResult.status !== Status.FAILED) {
      testStepResult = await runStepFn()
      if (testStepResult.status === Status.PASSED) {
        stepAfterHooksResult = await this.runStepHooks(step, false)
      }
    }
    let cumulatedStepResult = stepBeforeHooksResult
    if (testStepResult) {
      cumulatedStepResult = testStepResult
      if (stepBeforeHooksResult.duration !== undefined) {
        cumulatedStepResult.duration += stepBeforeHooksResult.duration
      }
    }
    if (stepAfterHooksResult) {
      if (stepAfterHooksResult.duration !== undefined) {
        cumulatedStepResult.duration += stepAfterHooksResult.duration
      }
      if (this.shouldUpdateStatus(stepAfterHooksResult)) {
        cumulatedStepResult.status = stepAfterHooksResult.status
      }
      if (stepAfterHooksResult.exception) {
        cumulatedStepResult.exception = stepAfterHooksResult.exception
      }
    }
    this.finishStep(cumulatedStepResult)
  }

  async run() {
    this.emitPrepared()
    for (
      this.currentAttemptNumber = 1;
      this.currentAttemptNumber <= this.maxAttempts;
      this.currentAttemptNumber++
    ) {
      this.emit('test-case-started')
      await this.runHooks(
        this.beforeHookDefinitions,
        {
          sourceLocation: this.testCaseSourceLocation,
          pickle: this.testCase.pickle,
        },
        true
      )
      await this.runSteps()
      const shouldRetry =
        this.result.status === Status.FAILED &&
        this.currentAttemptNumber < this.maxAttempts
      if (shouldRetry) {
        this.result.retried = true
      }
      await this.runHooks(
        this.afterHookDefinitions,
        {
          sourceLocation: this.testCaseSourceLocation,
          pickle: this.testCase.pickle,
          result: this.result,
        },
        false
      )
      this.emit('test-case-finished', { result: this.result })
      if (!shouldRetry) {
        break
      }
      this.resetTestProgressData()
    }
    return this.result
  }

  async runHook(hookDefinition, hookParameter, isBeforeHook) {
    if (this.shouldSkipHook(isBeforeHook)) {
      return { status: Status.SKIPPED }
    }
    return this.invokeStep(null, hookDefinition, hookParameter)
  }

  async runHooks(hookDefinitions, hookParameter, isBeforeHook) {
    await Promise.each(hookDefinitions, async hookDefinition => {
      await this.aroundTestHook(() =>
        this.runHook(hookDefinition, hookParameter, isBeforeHook)
      )
    })
  }

  async runStepHooks(step, isBeforeHook) {
    const status =
      this.result.status === Status.FAILED ? Status.SKIPPED : this.result.status
    const stepHooksResult = { status: status }
    if (step) {
      const stepInfo = {
        text: step.text,
        arguments: step.arguments,
        location: Object.assign({ uri: this.testCase.uri }, step.locations[0]),
      }
      let stepHooks = []
      if (isBeforeHook) {
        stepHooks = this.beforeStepHookDefinitions
      } else {
        stepHooks = this.afterStepHookDefinitions
      }
      await Promise.each(stepHooks, async stepHook => {
        if (this.isSkippingSteps()) {
          stepHooksResult.status = Status.SKIPPED
          return
        }
        const stepHookResult = await this.invokeStep(null, stepHook, stepInfo)
        if (this.shouldUpdateStatus(stepHookResult)) {
          stepHooksResult.status = stepHookResult.status
        }
        if (stepHookResult.exception) {
          stepHooksResult.exception = stepHookResult.exception
        }
        if (stepHookResult.duration) {
          stepHooksResult.duration = stepHooksResult.duration
            ? stepHooksResult.duration + stepHookResult.duration
            : stepHookResult.duration
        }
      })
    }
    return stepHooksResult
  }

  async runStep(step) {
    const stepDefinitions = this.getStepDefinitions(step)
    if (stepDefinitions.length === 0) {
      return { status: Status.UNDEFINED }
    } else if (stepDefinitions.length > 1) {
      return {
        exception: getAmbiguousStepException(stepDefinitions),
        status: Status.AMBIGUOUS,
      }
    } else if (this.isSkippingSteps()) {
      return { status: Status.SKIPPED }
    }
    return this.invokeStep(step, stepDefinitions[0])
  }

  async runSteps() {
    await Promise.each(this.testCase.pickle.steps, async step => {
      await this.aroundTestStep(() => this.runStep(step), step)
    })
  }
}
