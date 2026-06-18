// Supabase Edge Function: Generate Firebase Custom Token (v2 - JWT Manual)
// This function creates a Firebase custom token for authenticated Supabase users using JWT

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { encode } from 'https://deno.land/std@0.168.0/encoding/base64.ts'

// Generate Firebase Custom Token manually using JWT
async function generateFirebaseToken(uid: string, claims: Record<string, any>): Promise<string> {
  const projectId = Deno.env.get('FIREBASE_PROJECT_ID')
  const clientEmail = Deno.env.get('FIREBASE_CLIENT_EMAIL')
  const privateKey = Deno.env.get('FIREBASE_PRIVATE_KEY')?.replace(/\\n/g, '\n')

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error('Missing Firebase credentials')
  }

  const now = Math.floor(Date.now() / 1000)
  
  // JWT Header
  const header = {
    alg: 'RS256',
    typ: 'JWT'
  }
  
  // JWT Payload
  const payload = {
    iss: clientEmail,
    sub: clientEmail,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat: now,
    exp: now + 3600,
    uid: uid,
    claims: claims
  }

  // Encode to base64
  const encodeBase64 = (str: string): string => {
    return encode(new TextEncoder().encode(str)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  }

  const headerB64 = encodeBase64(JSON.stringify(header))
  const payloadB64 = encodeBase64(JSON.stringify(payload))
  const message = `${headerB64}.${payloadB64}`

  // Import private key and sign
  const pemHeader = '-----BEGIN PRIVATE KEY-----'
  const pemFooter = '-----END PRIVATE KEY-----'
  const pemContents = privateKey.substring(
    privateKey.indexOf(pemHeader) + pemHeader.length,
    privateKey.indexOf(pemFooter)
  ).replace(/\s/g, '')
  
  const binaryDer = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0))
  
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    binaryDer.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  )

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(message)
  )

  const signatureB64 = encodeBase64(String.fromCharCode(...new Uint8Array(signature)))
  
  return `${message}.${signatureB64}`
}

serve(async (req) => {
  // CORS headers
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  }

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Create Supabase client with auth context
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      {
        global: {
          headers: { Authorization: req.headers.get('Authorization') ?? '' },
        },
      }
    )

    // Get current user
    const {
      data: { user },
      error: userError,
    } = await supabaseClient.auth.getUser()

    if (userError || !user) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { 
          status: 401, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      )
    }

    // Get user profile for role information
    const { data: profile, error: profileError } = await supabaseClient
      .from('profiles')
      .select('role, nom, prenom')
      .eq('id', user.id)
      .single()

    if (profileError) {
      console.error('Profile fetch error:', profileError)
    }

    // Generate Firebase custom token
    const customToken = await generateFirebaseToken(user.id, {
      email: user.email,
      supabaseUid: user.id,
      role: profile?.role || 'client',
      nom: profile?.nom || '',
      prenom: profile?.prenom || '',
    })

    return new Response(
      JSON.stringify({ 
        token: customToken,
        user: {
          uid: user.id,
          email: user.email,
          role: profile?.role || 'client',
        }
      }),
      { 
        status: 200, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    )

  } catch (error) {
    console.error('Error generating Firebase token:', error)
    return new Response(
      JSON.stringify({ error: 'Internal server error', details: error.message }),
      { 
        status: 500, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    )
  }
})
