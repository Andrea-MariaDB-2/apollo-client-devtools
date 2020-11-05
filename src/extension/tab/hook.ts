import { DocumentNode, Source } from "graphql";
import { gql, Observable, ApolloClient } from "@apollo/client";
import { getMainDefinition } from "@apollo/client/utilities";
import { version as devtoolsVersion } from "../manifest.json";
import Relay from "../../Relay";
import { GraphiQLResponse, QueryResult } from '../../types';
import { 
  DEVTOOLS_INITIALIZED,
  CREATE_DEVTOOLS_PANEL,
  ACTION_HOOK_FIRED, 
  GRAPHIQL_REQUEST,
  GRAPHIQL_RESPONSE,
  REQUEST_DATA,
  UPDATE,
} from "../constants";

declare global {
  type TCache = any;

  interface Window {
    __APOLLO_CLIENT__: ApolloClient<TCache>
  }
}

type QueryInfo = {
  document: DocumentNode;
  source?: Source,
  variables?: Record<string, any>;
  diff?: Record<string, any>;
}

type Hook = {
  ApolloClient: ApolloClient<TCache> | undefined;
  version: string;
  getQueries: () => Map<string, QueryInfo> | void;
  getMutations: () => ({});
  getCache: () => void;
}

function initializeHook() {
  const hook: Hook = {
    ApolloClient: undefined,
    version: devtoolsVersion,
    getQueries: () => {},
    getMutations: () => ({}),
    getCache: () => {},
  };

  Object.defineProperty(window, '__APOLLO_DEVTOOLS_GLOBAL_HOOK__', {
    get() {
      return hook;
    },
  });

  const clientRelay = new Relay();

  clientRelay.addConnection('tab', message => {
    window.postMessage(message, '*');
  });

  window.addEventListener('message', ({ data }) => {
    clientRelay.broadcast(data);
  });

  // TODO: Handshake to get the tab id?
  function getQueries(): QueryInfo[] {
    const queryMap = hook.getQueries();
    let queries: QueryInfo[] = [];

    if (queryMap) {
      queries = [...queryMap.values()].map(({ 
        document, 
        variables,
        diff,
      }) => ({
          document,
          source: document?.loc?.source, 
          variables,
          cachedData: diff?.result,
        })
      )
    }

    return queries;
  }

  function getMutations() {
    const mutationsObj = hook.getMutations();
    const keys = Object.keys(mutationsObj);

    if (keys.length === 0) {
      return [];
    }

    return keys.map(key => {
      const { mutation, variables } = mutationsObj[key];
      return {
        document: mutation,
        variables,
        source: mutation?.loc?.source, 
      }
    });
  }

  function sendMessageToTab<TPayload>(message: string, payload?: TPayload) {
    clientRelay.send({
      to: 'tab',
      message,
      payload,
    });
  }

  function handleActionHookForDevtools() {
    sendMessageToTab(ACTION_HOOK_FIRED);
  }

  function handleGraphiQlResponse(payload: GraphiQLResponse) {
    sendMessageToTab(GRAPHIQL_RESPONSE, payload);
  }

  clientRelay.listen(DEVTOOLS_INITIALIZED, () => {
    if (hook.ApolloClient) {

      // Tab Relay forwards this the devtools
      sendMessageToTab(CREATE_DEVTOOLS_PANEL, 
        JSON.stringify({
          queries: getQueries(),
          mutations: getMutations(),
          cache: hook.getCache(),
        })
      );
    }
  });

  clientRelay.listen(REQUEST_DATA, () => {
    // Tab Relay forwards this the devtools
    sendMessageToTab(UPDATE, 
      JSON.stringify({
        queries: getQueries(),
        mutations: getMutations(),
        cache: hook.getCache(),
      })
    );
  });

  clientRelay.listen(GRAPHIQL_REQUEST, ({ payload }) => {
    const { query, operationName, fetchPolicy, variables } = JSON.parse(payload);

    const queryAst = gql(query);
    const definition = getMainDefinition(queryAst);

    const operation = (() => {
      if (definition.kind === 'OperationDefinition' && definition.operation === 'mutation') {
        return new Observable(observer => {
          hook.ApolloClient!.mutate({
              mutation: queryAst,
              variables,
          }).then(result => {
            observer.next(result);
          });
        });
      } else {
        return hook.ApolloClient!.watchQuery({
          query: queryAst,
          variables,
          fetchPolicy,
        });
      }
    })();

    operation.subscribe((response: QueryResult) => {
      handleGraphiQlResponse({
        operationName, 
        response,
      });
    });
  });

  function findClient() {
    let interval;
    let count = 0;
  
    function initializeDevtoolsHook() {
      if (count++ > 10) clearInterval(interval);
      if (!!window.__APOLLO_CLIENT__) {
        hook.ApolloClient = window.__APOLLO_CLIENT__;
        hook.ApolloClient.__actionHookForDevTools(handleActionHookForDevtools);
        hook.getQueries = () => (hook.ApolloClient as any).queryManager.queries;
        hook.getMutations = () => (hook.ApolloClient as any).queryManager.mutationStore.getStore();
        hook.getCache = () => hook.ApolloClient!.cache.extract(true);
  
        clearInterval(interval);
      }
    }
    
    interval = setInterval(initializeDevtoolsHook, 1000);
  }

  // Attempt to find the client on a 1-second interval for 10 seconds max
  findClient();
}

initializeHook();
