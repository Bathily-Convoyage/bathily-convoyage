const BUFFER_ENDPOINT = 'https://api.buffer.com';

class BufferApiError extends Error {
  constructor(message, { status, classification, details } = {}) {
    super(message);
    this.name = 'BufferApiError';
    this.status = status;
    this.classification = classification;
    this.details = details;
  }
}

export async function bufferGraphql({
  token,
  query,
  variables,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000
}) {
  if (!token || typeof token !== 'string') {
    throw new BufferApiError('Buffer token is required', { classification: 'missing_token' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new BufferApiError('Buffer request timed out', { classification: 'timeout' }));
    }, timeoutMs);
  });

  let response;
  try {
    response = await Promise.race([
      fetchImpl(BUFFER_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal
      }),
      timeoutPromise
    ]);
  } catch (err) {
    if (err instanceof BufferApiError) throw err;
    const classification = err.name === 'AbortError' ? 'timeout' : 'network_error';
    throw new BufferApiError(`Buffer request failed: ${classification}`, { classification, details: err.name });
  } finally {
    clearTimeout(timeout);
  }

  let text;
  try {
    text = await response.text();
  } catch (err) {
    throw new BufferApiError('Failed to read Buffer response body', { status: response.status, classification: 'body_read_error' });
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new BufferApiError('Buffer response was not valid JSON', { status: response.status, classification: 'non_json_response' });
  }

  if (!response.ok) {
    throw new BufferApiError(`Buffer HTTP error ${response.status}`, { status: response.status, classification: 'http_error', details: json });
  }

  if (json.errors && Array.isArray(json.errors) && json.errors.length > 0) {
    const messages = json.errors.map(e => e.message).join('; ');
    throw new BufferApiError(`Buffer GraphQL error: ${messages}`, { status: response.status, classification: 'graphql_top_level_error', details: json.errors });
  }

  return json.data ?? null;
}

export async function getOrganizations({ token, fetchImpl }) {
  const query = `
    query GetAccount {
      account {
        organizations {
          id
        }
      }
    }
  `;
  const data = await bufferGraphql({ token, query, fetchImpl });
  return data?.account?.organizations ?? [];
}

export async function getChannels({ token, organizationId, fetchImpl }) {
  const query = `
    query GetChannels($input: ChannelsInput!) {
      channels(input: $input) {
        channels {
          id
          service
        }
      }
    }
  `;
  const data = await bufferGraphql({
    token,
    query,
    variables: { input: { organizationId } },
    fetchImpl
  });
  return data?.channels?.channels ?? [];
}

export async function getRecentPostsForChannel({ token, channelId, since, fetchImpl }) {
  const query = `
    query GetPosts($filter: PostsFilterInput!) {
      posts(filter: $filter) {
        posts {
          id
          text
          createdAt
          dueAt
        }
      }
    }
  `;
  const data = await bufferGraphql({
    token,
    query,
    variables: { filter: { channelId, since } },
    fetchImpl
  });
  return data?.posts?.posts ?? [];
}

export async function createBufferPost({
  token,
  text,
  channelId,
  schedulingType = 'automatic',
  mode = 'shareNow',
  assets,
  metadata,
  fetchImpl
}) {
  const query = `
    mutation CreatePost($input: CreatePostInput!) {
      createPost(input: $input) {
        __typename
        ... on PostActionSuccess {
          post {
            id
          }
        }
        ... on MutationError {
          message
        }
      }
    }
  `;
  const variables = {
    input: {
      text,
      channelId,
      schedulingType,
      mode,
      ...(assets && assets.length > 0 ? { assets } : {}),
      ...(metadata ? { metadata } : {})
    }
  };

  const data = await bufferGraphql({ token, query, variables, fetchImpl });
  const result = data?.createPost;

  if (!result) {
    throw new BufferApiError('createPost returned no result', { classification: 'unexpected_response_shape' });
  }

  if (result.__typename === 'MutationError') {
    throw new BufferApiError(`Buffer mutation error: ${result.message || 'unknown'}`, { classification: 'mutation_error' });
  }

  if (result.__typename !== 'PostActionSuccess' || !result.post?.id) {
    throw new BufferApiError('createPost did not return PostActionSuccess', { classification: 'unexpected_response_shape' });
  }

  return result.post.id;
}

export { BufferApiError };
