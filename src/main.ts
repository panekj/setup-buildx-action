import * as os from 'os';
import * as path from 'path';
import * as buildx from './buildx';
import * as context from './context';
import * as stateHelper from './state-helper';
import * as util from './util';
import * as core from '@actions/core';
import * as exec from '@actions/exec';

async function run(): Promise<void> {
  try {
    core.startGroup(`Docker info`);
    await exec.exec('docker', ['version']);
    await exec.exec('docker', ['info']);
    core.endGroup();

    const inputs: context.Inputs = await context.getInputs();
    const dockerConfigHome: string = process.env.DOCKER_CONFIG || path.join(os.homedir(), '.docker');

    if (util.isValidUrl(inputs.version)) {
      core.startGroup(`Build and install buildx`);
      await buildx.build(inputs.version, dockerConfigHome);
      core.endGroup();
    } else if (!(await buildx.isAvailable()) || inputs.version) {
      core.startGroup(`Download and install buildx`);
      await buildx.install(inputs.version || 'latest', dockerConfigHome);
      core.endGroup();
    }

    const buildxVersion = await buildx.getVersion();
    const builderName: string = inputs.driver == 'docker' ? 'default' : `builder-${inputs.builderName}`;
    context.setOutput('name', builderName);
    stateHelper.setBuilderName(builderName);

    if (inputs.driver !== 'docker') {
      core.startGroup(`Creating a new builder instance`);
      let createArgs: Array<string> = ['buildx', 'create', '--name', builderName, '--driver', inputs.driver];
      if (buildx.satisfies(buildxVersion, '>=0.3.0')) {
        await context.asyncForEach(inputs.driverOpts, async driverOpt => {
          createArgs.push('--driver-opt', driverOpt);
        });
        if (inputs.buildkitdFlags) {
          createArgs.push('--buildkitd-flags', inputs.buildkitdFlags);
        }
      }
      if (inputs.use) {
        createArgs.push('--use');
      }
      if (inputs.endpoint) {
        createArgs.push(inputs.endpoint);
      }
      if (inputs.config) {
        createArgs.push('--config', inputs.config);
      }
      await exec.exec('docker', createArgs);
      core.endGroup();

      core.startGroup(`Booting builder`);
      let bootstrapArgs: Array<string> = ['buildx', 'inspect', '--bootstrap'];
      if (buildx.satisfies(buildxVersion, '>=0.4.0')) {
        bootstrapArgs.push('--builder', builderName);
      }
      await exec.exec('docker', bootstrapArgs);
      core.endGroup();
    }

    if (inputs.install) {
      core.startGroup(`Setting buildx as default builder`);
      await exec.exec('docker', ['buildx', 'install']);
      core.endGroup();
    }

    core.startGroup(`Inspect builder`);
    const builder = await buildx.inspect(builderName);
    core.info(JSON.stringify(builder, undefined, 2));
    context.setOutput('driver', builder.driver);
    context.setOutput('endpoint', builder.node_endpoint);
    context.setOutput('status', builder.node_status);
    context.setOutput('flags', builder.node_flags);
    context.setOutput('platforms', builder.node_platforms);
    core.endGroup();

    if (inputs.driver == 'docker-container') {
      stateHelper.setContainerName(`buildx_buildkit_${builder.node_name}`);
      core.startGroup(`BuildKit version`);
      core.info(await buildx.getBuildKitVersion(`buildx_buildkit_${builder.node_name}`));
      core.endGroup();
    }
    if (core.isDebug() || builder.node_flags?.includes('--debug')) {
      stateHelper.setDebug('true');
    }
  } catch (error) {
    core.setFailed(error.message);
  }
}

async function cleanup(): Promise<void> {
  if (stateHelper.IsDebug && stateHelper.containerName.length > 0) {
    core.startGroup(`BuildKit container logs`);
    await exec
      .getExecOutput('docker', ['logs', `${stateHelper.containerName}`], {
        ignoreReturnCode: true
      })
      .then(res => {
        if (res.stderr.length > 0 && res.exitCode != 0) {
          core.warning(res.stderr.trim());
        }
      });
    core.endGroup();
  }

  if (stateHelper.builderName.length > 0) {
    core.startGroup(`Removing builder`);
    await exec
      .getExecOutput('docker', ['buildx', 'rm', `${stateHelper.builderName}`], {
        ignoreReturnCode: true
      })
      .then(res => {
        if (res.stderr.length > 0 && res.exitCode != 0) {
          core.warning(res.stderr.trim());
        }
      });
    core.endGroup();
  }
}

if (!stateHelper.IsPost) {
  run();
} else {
  cleanup();
}
