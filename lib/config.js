// Table names and heuristics. Documented names (ServiceNow docs, Australia) are marked [V];
// the rest are best-effort [U] and are probed at run time, so a missing table is skipped, not fatal.

export const TABLES = {
  plan: ['sn_aia_execution_plan'],                 // [V]
  task: ['sn_aia_execution_task'],                 // [V]
  message: ['sn_aia_message'],                     // [V]
  toolExec: ['sn_aia_tools_execution', 'sn_aia_tool_execution'], // [U] the plan's "Execution tools" list [V]
  agent: ['sn_aia_agent'],                         // [V]
  agentToolM2M: ['sn_aia_agent_tool_m2m'],         // [V]
  teamMember: ['sn_aia_team_member'],              // [V]
  trigger: ['sn_aia_trigger_configuration'],       // [V]
  memory: ['sn_aia_memory'],                       // [V]
  workflow: ['sn_aia_usecase'],                    // [U]
  tool: ['sn_aia_tool'],                           // [U]
  skill: ['sn_nowassist_skill_config', 'sn_nowassist_skill_config_status'], // [U] / [V]
  prompt: ['sys_generative_ai_config', 'sys_generative_ai_prompt_config'], // [V] (prompt_config: Brazil upgrade notes)
  agentProperty: ['sn_aia_property'],              // [V] Brazil upgrade notes
  externalAgent: ['sn_aia_external_agent_configuration'], // [V] Brazil upgrade notes
  genaiLog: ['sys_generative_ai_log'],             // [V]
  usageLog: ['sys_gen_ai_usage_log'],              // [V]
  logMetadata: ['sys_gen_ai_log_metadata'],        // [V]
  capability: ['sys_one_extend_capability'],       // [V]
  conversation: ['sys_cs_conversation'],           // [U]
  syslog: ['syslog'],
  http: ['sys_outbound_http_log'],                 // [U]
  flow: ['sys_flow_context'],                      // [U]
  rca: ['sys_restricted_caller_access'],           // [U]
};

// Order used when an ID is pasted without a table: first hit wins.
export const RESOLVE_ORDER = [
  'plan', 'agent', 'workflow', 'tool', 'skill', 'prompt', 'genaiLog',
  'task', 'message', 'toolExec', 'conversation', 'capability',
];

export const KIND_LABEL = {
  plan: 'Execution plan', agent: 'AI agent', workflow: 'Agentic workflow', tool: 'Tool',
  skill: 'AI skill (Now Assist / ServiceNow Otto)', prompt: 'Prompt config', genaiLog: 'Gen AI log entry',
  task: 'Execution task', message: 'Agent message', toolExec: 'Tool execution', conversation: 'VA conversation',
  capability: 'OneExtend capability',
};

// Reverse-reference discovery only follows child tables with these prefixes,
// so we don't drag in sys_audit, sys_journal_field and friends.
export const CHILD_TABLE_PREFIXES = [
  'sn_aia', 'sys_gen', 'sys_generative', 'sn_nowassist', 'sn_now_assist', 'sys_one_extend', 'sys_cs_',
];

// Store apps whose versions matter for AI debugging.
export const PLUGIN_SCOPE_QUERY = [
  'scopeSTARTSWITHsn_aia', 'scopeSTARTSWITHsn_generative', 'scopeSTARTSWITHsn_nowassist',
  'scopeSTARTSWITHsn_now_assist', 'scopeLIKEgen_ai', 'scopeLIKEone_extend', 'scopeLIKEskill_kit', 'scopeLIKEmcp',
].join('^OR');

// ACL types for agentic AI. Brazil enforces deny-by-default for these on newly activated
// instances: each agent, workflow, skill, flow and flow action needs its own ACL. [V] Brazil release notes
export const AI_ACL_TYPES = ['gen_ai_agent', 'gen_ai_workflow', 'gen_ai_skill', 'flow', 'flow_action'];

// Build tag / build name properties used to tell the release family and patch.
export const RELEASE_PROPS = ['glide.buildtag.last', 'glide.buildtag', 'glide.buildname', 'glide.war'];
export const RELEASE_ORDER = ['washingtondc', 'xanadu', 'yokohama', 'zurich', 'australia', 'brazil'];

// Heuristic field matchers, applied to real field names discovered from sys_dictionary.
export const FIELD_HINTS = {
  state: [/^state$/, /^status$/, /state/, /status/],
  error: [/^error$/, /error_message/, /^error/, /exception/, /failure/, /error/],
  input: [/^input$/, /^inputs$/, /input_payload/, /request/, /input/],
  output: [/^output$/, /^outputs$/, /^response$/, /^result$/, /output/, /response/, /result/],
  name: [/^name$/, /^display_name$/, /^label$/, /^title$/, /name/],
  instructions: [/^instructions$/, /instruction/, /^prompt$/, /role/],
  description: [/^description$/, /description/],
  active: [/^active$/],
  prompt: [/^prompt$/, /final_prompt/, /prompt/],
  inputSchema: [/input_schema/, /^inputs$/, /input_parameters/, /tool_inputs/],
  start: [/^start/, /started/, /start_time/],
  end: [/^end/, /ended/, /end_time/, /completed/],
  duration: [/duration/, /response_time/, /elapsed/],
  content: [/^content$/, /^message$/, /^text$/, /content/, /message/],
  guard: [/guard/, /offensive/, /injection/, /sensitive/, /blocked/],
  level: [/^level$/],
  source: [/^source$/],
  httpStatus: [/response_status/, /status_code/, /^status$/],
  url: [/^url$/, /endpoint/, /url/],
};

export const DEFAULT_SETTINGS = {
  windowMinutes: 2,        // +/- buffer around a run when pulling time-correlated logs
  rowLimit: 50,            // max rows per child table
  redact: true,            // redact PII in exports
  includeBodies: false,    // include full prompt/response bodies in exports
  stuckMinutes: 5,         // plan age before a non-terminal state counts as stuck
  actionsEnabled: false,   // show the opt-in stop-script actions
};
