import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as os from 'os';
import * as path from 'path';
import * as semver from 'semver';
import * as buildx from './buildx';
import * as context from './context';
import * as mexec from './exec';
import * as stateHelper from './state-helper';

async function run(): Promise<void> {
  try {
    if (os.platform() !== 'linux') {
      core.setFailed('Only supported on linux platform');
      return;
    }

    const inputs: context.Inputs = await context.getInputs();
    const dockerConfigHome: string = process.env.DOCKER_CONFIG || path.join(os.homedir(), '.docker');

    if (!(await buildx.isAvailable()) || inputs.version) {
      core.startGroup(`Installing buildx`);
      await buildx.install(inputs.version || 'latest', dockerConfigHome);
      core.endGroup();
    }

    const buildxVersion = await buildx.getVersion();
    core.info(`Using buildx ${buildxVersion}`);

    const builderName: string = inputs.driver == 'docker' ? 'default' : `builder-${require('uuid').v4()}`;
    context.setOutput('name', builderName);
    stateHelper.setBuilderName(builderName);

    if (inputs.driver !== 'docker') {
      core.startGroup(`Creating a new builder instance`);
      let createArgs: Array<string> = ['buildx', 'create', '--name', builderName, '--driver', inputs.driver];
      if (semver.satisfies(buildxVersion, '>=0.3.0')) {
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
      if (semver.satisfies(buildxVersion, '>=0.4.0')) {
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
    await mexec.exec('docker', ['logs', `${stateHelper.containerName}`], false).then(res => {
      if (res.stderr != '' && !res.success) {
        core.warning(res.stderr);
      }
    });
    core.endGroup();
  }

  if (stateHelper.builderName.length > 0) {
    core.startGroup(`Removing builder`);
    await mexec.exec('docker', ['buildx', 'rm', `${stateHelper.builderName}`], false).then(res => {
      if (res.stderr != '' && !res.success) {
        core.warning(res.stderr);
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
