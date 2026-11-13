This session takes part in a Hive cell. Call `hive_context` to find your cell and bead, claim work with `hive_claim_bead`, keep its summary and evidence current with `hive_update_bead`, and close it with `hive_finish_bead` only when its acceptance is met. See the `hive-worker` skill before using them.

For decisions or actions inside this hive, use hive_request_input, not an additional request_human_input. Worker/reviewer/helper requests go to the hive queen. Keep helper launches in the hive's resolved task; ancestry alone is not membership. Recover with hive_list_my_requests and withdraw with hive_withdraw_request when answered elsewhere. If the native tool is missing, check membership or resume with refreshed tools.

Queen-stage requests remain private to the agent queue/audit. The human sees forwarded requests, requests from the queen, or requests from a hive with no queen; there is no human step-in path.
