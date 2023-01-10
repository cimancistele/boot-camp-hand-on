import convertpro from 'convert-pro';
import {ConfigServiceClient, PutEvaluationsCommand, GetResourceConfigHistoryCommand} from '@aws-sdk/client-config-service';
import {EC2Client, DescribeInstanceTypesCommand} from '@aws-sdk/client-ec2';

const configServiceClient = new ConfigServiceClient({region: process.env.REGION});
const ec2Client = new EC2Client({region: 'us-east-1'});
const convert = convertpro.default;

const COMPLIANCE_STATES = {
  COMPLIANT : 'COMPLIANT',
  NON_COMPLIANT : 'NON_COMPLIANT',
  NOT_APPLICABLE : 'NOT_APPLICABLE'
};

export async function handler(event, context){
  checkDefined( 'event', event);

  checkDefined( 'invokingEvent', event.invokingEvent);
  const invokingEvent = JSON.parse(event.invokingEvent);
  
  const configurationItem = await getConfigurationItem(invokingEvent);

  await evaluateCompliance(configurationItem, event);
}

async function getConfigurationItem(invokingEvent){
  checkDefined('mesageType', invokingEvent.messageType);
  if (invokingEvent.messageType == "OversizedConfigurationItemChangeNotification") {
    const configurationItemSummary = checkDefined('configurationItemSummary', invokingEvent.configurationItemSummary);

    const getResourceConfigHistoryCommandInput = {
      limit: 1,
      laterTime: new Date(configurationItemSummary.configurationItemCaptureTime),
      resourceType: configurationItemSummary.resourceType,
      resourceId: configurationItemSummary.resourceId
    };

    console.log(getResourceConfigHistoryCommandInput);


    const getResourceConfigHistoryCommand = new GetResourceConfigHistoryCommand(getResourceConfigHistoryCommandInput);
    const configurationItemHistory = await configServiceClient.send(getResourceConfigHistoryCommand);

    checkDefined('configurationItemHistory.configurationItems', configurationItemHistory.configurationItems);

    return convertHistoryResult(configurationItemHistory.configurationItems[0]);

  } else {
    return checkDefined('configurationItem', invokingEvent.configurationItem);
  }
}

//convert item history api call result to normal event 
function convertHistoryResult(configurationItemHistory){
  const configurationItem = {
    ...configurationItemHistory,
    ARN: configurationItemHistory.arn,
    awsAccountId: configurationItemHistory.accountId,
    configurationStateMd5Hash: configurationItemHistory.configurationItemMD5Hash,
    configuration: JSON.parse(configurationItemHistory.configuration),
    configurationItemVersion: configurationItemHistory.version,
  };

  if ({}.hasOwnProperty.call(configurationItemHistory, 'relationships')) {

    configurationItem.relationships = configurationItemHistory.relationships.map(x => { 
        return {
        ...x,
        name: x.relationshipName
      }
    });
  }

  return configurationItem;
}

async function evaluateCompliance(configurationItem, event){
  let complicance = COMPLIANCE_STATES.NOT_APPLICABLE;
  const eventLeftScope = checkDefined('eventLeftScope', event.eventLeftScope);

  if(isApplicable(configurationItem, eventLeftScope)){

    complicance = COMPLIANCE_STATES.COMPLIANT;

    checkDefined( 'ruleParameters', event.ruleParameters);
    const ruleParameters = JSON.parse(event.ruleParameters);

    const cpuLimit = Number(checkDefined('cpu-limit', ruleParameters["cpu-limit"]));
    const ramLimit = Number(checkDefined('ram-limit', ruleParameters["ram-limit"]));

    const describeInstanceTypesCommandInput = {
      InstanceTypes: [checkDefined('instanceType', configurationItem.configuration.instanceType)]
    }

    const describeInstanceTypesCommand = new DescribeInstanceTypesCommand(describeInstanceTypesCommandInput);
    const instanceTypesDescriptions = await ec2Client.send(describeInstanceTypesCommand);

    checkDefined('instanceTypesDescriptions.InstanceTypes' ,instanceTypesDescriptions.InstanceTypes)
    const description = instanceTypesDescriptions.InstanceTypes[0];

    const instanceVCpus = Number(checkDefined('DefaultVCpus', description.VCpuInfo.DefaultVCpus));

    const instanceRamInGiB = convert.bytes([description.MemoryInfo.SizeInMiB, "MiB"], "GiB");

    if (instanceVCpus > cpuLimit || instanceRamInGiB > ramLimit ){
      complicance = COMPLIANCE_STATES.NON_COMPLIANT;
    }
  }

  const putEvaluationsCommandInput = {
    ResultToken: event.resultToken,
    Evaluations: [{
      ComplianceResourceId: configurationItem.resourceId,
      ComplianceResourceType: configurationItem.resourceType,
      ComplianceType: complicance,
      OrderingTimestamp: new Date(configurationItem.configurationItemCaptureTime)
    }]  
  };

  const putEvaluationsCommand = new PutEvaluationsCommand(putEvaluationsCommandInput);

  await configServiceClient.send(putEvaluationsCommand);
}

//check if the item is deleted
function isApplicable(configurationItem, eventLeftScope) {
  checkDefined(configurationItem, 'configurationItem');
  const status = configurationItem.configurationItemStatus;
  return (status === 'OK' || status === 'ResourceDiscovered') && eventLeftScope === false;
}

function checkDefined(refName ,ref){
  if (typeof ref === "boolean") {
    return ref;
  }

  if(!ref) {
    throw new Error(`Error: ${refName} is not defined`);
  }

  return ref;
}