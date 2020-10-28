// Apollo Client 2 stores query information in an object, whereas AC3 uses
// a Map. Devtools are expecting to work with an object, so this function
// will convert an AC3 query info Map to an object, while also filtering out
// the query details we don't need.
function filterQueryInfo(queryInfoMap) {
  const filteredQueryInfo = {};
  queryInfoMap.forEach((value, key) => {
    filteredQueryInfo[key] = {
      document: value.document,
      graphQLErrors: value.graphQLErrors,
      networkError: value.networkError,
      networkStatus: value.networkStatus,
      variables: value.variables,
    };
  });
  return filteredQueryInfo;
}

export const initBroadCastEvents = (hook, bridge) => {
  let client = null;
  
  // Counters for diagnostics
  let counter = 0;

  // Next broadcast to be sent
  let enqueued = null;

  // Whether backend is ready for another broadcast
  let acknowledged = true;

  // Threshold for warning about state size in Megabytes
  let warnMB = 10;

  // Minimize impact to webpage. Serializing large state could cause jank
  function scheduleBroadcast() {
    acknowledged = false;
    requestIdleCallback(sendBroadcast, { timeout: 120 /*max 2min*/ });
  }

  // Send the Apollo broadcast to the devtools
  function sendBroadcast() {
    const msg = JSON.stringify(enqueued);
    bridge.send("broadcast:new", msg);
    enqueued = null;

    if (msg.length > warnMB * 1000000) {
      const currentMB = msg.length / 1000000;
      console.warn(
        `Apollo DevTools serialized state is ${currentMB.toFixed(1)} MB. ` +
        "This may cause performance degradation.",
      );
      // Warn again if it doubles
      warnMB = currentMB * 2;
    }
  }

  let logger = ({
    state: { queries, mutations },
    dataWithOptimisticResults: inspector,
  }) => {
    counter++;
    enqueued = {
      counter,
      queries,
      mutations,
      inspector,
    };
    if (acknowledged) {
      scheduleBroadcast();
    }
  };

  // The backend has acknowledged receipt of a broadcast
  bridge.on("broadcast:ack", data => {
    acknowledged = true;
    if (enqueued) {
      scheduleBroadcast();
    }
  });

  bridge.on("panel:ready", () => {
    client = hook.ApolloClient;

    const queries =
      client.queryManager
        ? client.queryManager.queryStore
            // Apollo Client 2
            ? client.queryManager.queryStore.getStore()
            // Apollo Client 3
            : filterQueryInfo(client.queryManager.queries)
        : {};

    const mutations =
      client.queryManager
        ? (client.queryManager.mutationStore && client.queryManager.mutationStore.getStore)
            // Apollo Client 2 to 3.2
            ? client.queryManager.mutationStore.getStore()
            // Apollo Client 3.3+
            : client.queryManager.mutationStore
        : {};

    const initial = {
      queries,
      mutations,
      inspector: client.cache.extract(true),
    };

    bridge.send("broadcast:new", JSON.stringify(initial));
  });

  hook.ApolloClient.__actionHookForDevTools(logger);
};
