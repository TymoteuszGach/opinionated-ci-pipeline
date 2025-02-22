import {Repository} from 'aws-cdk-lib/aws-codecommit';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import {Construct} from 'constructs';
import {ApplicationProps, EnvironmentDeployment, IStacksCreation, ResolvedApplicationProps, WaveDeployment} from '../applicationProps';
import {CustomNodejsFunction} from './customNodejsFunction';
import * as path from 'path';
import {NotificationsTopic} from './notificationsTopic';
import {CodePipeline, CodePipelineProps, CodePipelineSource, ShellStep, Wave} from 'aws-cdk-lib/pipelines';
import {merge} from 'lodash';
import {getEnvironmentConfig, getProjectName} from '../util/context';
import {Aws, Stack} from 'aws-cdk-lib';
import {AppStage} from './appStage';
import {PolicyStatement} from 'aws-cdk-lib/aws-iam';
import {Code} from 'aws-cdk-lib/aws-lambda';
import {Topic} from 'aws-cdk-lib/aws-sns';
import {IStringParameter} from 'aws-cdk-lib/aws-ssm';
import {PipelineNotificationEvents} from 'aws-cdk-lib/aws-codepipeline';

export interface MainPipelineProps extends Pick<ResolvedApplicationProps,
    'stacks' | 'repository' | 'commands' |
    'pipeline' | 'cdkOutputDirectory' | 'codeBuild' | 'codePipeline'
> {
    codeCommitRepository: Repository;
    repositoryTokenParam: IStringParameter;
}

export class MainPipeline extends Construct {

    readonly failuresTopic: Topic;

    constructor(scope: Construct, id: string, props: MainPipelineProps) {
        super(scope, id);

        const source = CodePipelineSource.codeCommit(props.codeCommitRepository, props.repository.defaultBranch);

        const pipeline = new CodePipeline(this, 'Pipeline', merge<CodePipelineProps, Partial<CodePipelineProps> | undefined>({
            pipelineName: Stack.of(this).stackName,
            synth: new ShellStep('Synth', {
                input: source,
                installCommands: [
                    ...(props.commands.preInstall || []),
                    ...(props.commands.install || []),
                ],
                commands: [
                    ...(props.commands.buildAndTest || []),
                    ...props.commands.synthPipeline,
                ],
                primaryOutputDirectory: props.cdkOutputDirectory,
            }),
            crossAccountKeys: true,
            codeBuildDefaults: props.codeBuild,
        }, props.codePipeline));

        props.pipeline.forEach(step => {
            if (this.isWave(step)) {
                this.addWaveDeployment(pipeline, step, props.stacks);
            } else {
                this.addEnvironmentDeployment(pipeline, step, props.stacks);
            }
        });

        pipeline.buildPipeline();

        this.createPipelineBuildNotifications(pipeline, props.repository, props.repositoryTokenParam);

        this.failuresTopic = this.createPipelineFailuresTopic(pipeline);
    }

    private isWave(waveOrEnvironment: WaveDeployment | EnvironmentDeployment): waveOrEnvironment is WaveDeployment {
        return 'wave' in waveOrEnvironment;
    }

    private addWaveDeployment(pipeline: CodePipeline, step: WaveDeployment, stacks: IStacksCreation) {
        const wave = pipeline.addWave(step.wave);
        step.environments.forEach(env => {
            const environmentDeployment: EnvironmentDeployment = {
                ...env,
                pre: [
                    ...(step.preEachEnvironment || []),
                    ...(env.pre || []),
                ],
                post: [
                    ...(env.post || []),
                    ...(step.postEachEnvironment || []),
                ],
            };

            this.addEnvironmentDeployment(wave, environmentDeployment, stacks,
                `Wave${capitalizeFirstLetter(step.wave)}`, {WAVE_NAME: step.wave});
        });

        if (step.pre && step.pre.length > 0) {
            wave.addPre(new ShellStep(`PreWave${capitalizeFirstLetter(step.wave)}`, {
                env: {WAVE_NAME: step.wave},
                commands: step.pre,
            }));
        }
        if (step.post && step.post.length > 0) {
            wave.addPost(new ShellStep(`PostWave${capitalizeFirstLetter(step.wave)}`, {
                env: {WAVE_NAME: step.wave},
                commands: step.post,
            }));
        }
    }

    private addEnvironmentDeployment(parent: CodePipeline | Wave, step: EnvironmentDeployment, stacks: IStacksCreation, idPrefix = '', envVariables?: Record<string, string>) {
        const stage = parent.addStage(new AppStage(this, `${idPrefix}DeployEnv${capitalizeFirstLetter(step.environment)}`, {
            envName: step.environment,
            env: getEnvironmentConfig(this, step.environment),
            stacks,
        }));

        if (step.pre && step.pre.length > 0) {
            stage.addPre(new ShellStep(`${idPrefix}PreEnv${capitalizeFirstLetter(step.environment)}`, {
                env: {
                    ...envVariables,
                    ENV_NAME: step.environment,
                },
                commands: step.pre,
            }));
        }
        if (step.post && step.post.length > 0) {
            stage.addPost(new ShellStep(`${idPrefix}PostEnv${capitalizeFirstLetter(step.environment)}`, {
                env: {
                    ...envVariables,
                    ENV_NAME: step.environment,
                },
                commands: step.post,
            }));
        }
    }

    private createPipelineFailuresTopic(pipeline: CodePipeline): Topic {
        const failuresTopic = new NotificationsTopic(this, 'PipelineFailuresTopic', {
            projectName: getProjectName(this),
            notificationName: 'pipelineFailures',
        });

        pipeline.pipeline.notifyOn(
            'NotifyOnPipelineFailure',
            failuresTopic.topic,
            {
                events: [PipelineNotificationEvents.PIPELINE_EXECUTION_FAILED],
                notificationRuleName: `${Stack.of(this).stackName}-pipelineFailure`, // ensure unique name
            },
        );

        return failuresTopic.topic;
    }

    /**
     * To send CodePipeline build status back to repository:
     * - trigger Lambda function on CodePipeline state change events,
     * - in Lambda:
     *   - get CodePipeline execution details to get commit SHA,
     *   - send custom event to EventBridge including the commit SHA,
     * - use EventBridge to send build status to repository.
     */
    private createPipelineBuildNotifications(pipeline: CodePipeline, repository: ApplicationProps['repository'], repoTokenParam: IStringParameter) {
        const pipelineBuildStatusFunction = new CustomNodejsFunction(this, 'PipelineBuildStatus', {
            code: Code.fromAsset(path.join(__dirname, '..', 'lambda', 'pipelineBuildStatus')),
            environment: {
                REPOSITORY_HOST: repository.host,
                REPOSITORY_NAME: repository.name,
                REPOSITORY_TOKEN_PARAM_NAME: repoTokenParam.parameterName,
            },
        });
        repoTokenParam.grantRead(pipelineBuildStatusFunction);

        pipelineBuildStatusFunction.addToRolePolicy(new PolicyStatement({
            actions: ['codepipeline:GetPipelineExecution'],
            resources: [`arn:aws:codepipeline:${Aws.REGION}:${Aws.ACCOUNT_ID}:${pipeline.pipeline.pipelineName}`],
        }));

        pipeline.pipeline.onStateChange('OnPipelineStateChange', {
            target: new targets.LambdaFunction(pipelineBuildStatusFunction),
        });
    }
}

const capitalizeFirstLetter = (str: string): string => str.charAt(0).toUpperCase() + str.slice(1);
