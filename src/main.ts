// Imports and Environment Configuration
import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import cors from '@fastify/cors'
import fs from 'fs'
import { promises as fsPromises } from 'fs'
import { config } from 'dotenv'
import path from 'path'
import os from 'os'
import pdfParse from 'pdf-parse'
import axios from 'axios'
import { extractEbupot, getEbupotFormatedSignature } from './ebupot'

// Load and verify environment variables
config()
const environment = {
  port: process.env.PORT || 3000,
  username: process.env.NIS_USERNAME!,
  password: process.env.NIS_PASSWORD!,
  baseUrl: process.env.NIS_BASE_URL!,
  loginPath: process.env.NIS_LOGIN_PATH!,
  mainRoute: process.env.MAIN_ROUTE!,
  apiKeys: JSON.parse(process.env.API_KEYS || '[]'),
}
verifyEnvironment(environment)

// Function to verify required environment variables
function verifyEnvironment(env: any): void {
  const required = [
    env.username,
    env.password,
    env.baseUrl,
    env.loginPath,
    env.mainRoute,
  ]
  if (required.some((value) => !value)) {
    console.error('Missing required environment variables')
    process.exit(1)
  }
}

// Authentication and File Operations
let authCookie: string | null = null

async function retrieveAuthenticationCookie(): Promise<string> {
  const loginUrl = `${environment.baseUrl}${environment.loginPath}`
  const credentials = new URLSearchParams({
    userId: environment.username,
    pass: environment.password,
    submit: 'Login',
  })

  const response = await axios.post(loginUrl, credentials, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    maxRedirects: 0,
    validateStatus: (status) => status >= 200 && status < 400,
  })

  if (
    response.headers['set-cookie'] &&
    response.headers['set-cookie'].length > 0
  ) {
    authCookie = response.headers['set-cookie'][0]
    return authCookie
  }

  throw new Error('Failed to retrieve authentication cookie')
}

async function downloadFile(url: string, destination: string): Promise<void> {
  // Helper function to make the HTTP request
  async function makeRequest() {
    const response = await axios.get(url, {
      headers: { Cookie: authCookie },
      responseType: 'stream',
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400,
    })

    // If the response status is not OK, refresh the cookie and retry once
    if (response.status !== 200) {
      await retrieveAuthenticationCookie() // Refresh the cookie
      const retryResponse = await axios.get(url, {
        headers: { Cookie: authCookie },
        responseType: 'stream',
        maxRedirects: 0,
        validateStatus: (status) => status >= 200 && status < 400,
      })

      if (retryResponse.status !== 200) {
        throw new Error(
          `Failed to download file after retry: server responded with status code ${retryResponse.status}`,
        )
      }
      return retryResponse
    }

    return response
  }

  if (!authCookie) {
    await retrieveAuthenticationCookie()
  }

  const response = await makeRequest()

  const writer = fs.createWriteStream(destination)
  response.data.pipe(writer)

  return new Promise((resolve, reject) => {
    writer.on('finish', resolve)
    writer.on('error', (err) => {
      // Handle any errors during the writing process
      reject(err)
    })
  })
}

// Fastify Setup and Routes
const server = Fastify({ logger: true })

// Register CORS plugin
server.register(cors, {
  origin: '*', // Allow all origins.
  methods: ['GET', 'POST'],
})

async function authenticateRequest(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const apiKey = request.headers['x-api-key']
  if (!apiKey || !environment.apiKeys.includes(apiKey)) {
    reply.code(401).send({ error: 'Unauthorized' })
  }
}

async function handleMainRoute(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const fileUrl =
    environment.baseUrl + request.url.substring(environment.mainRoute.length)
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'download-'))
  const tempFilePath = path.join(tempDir, 'file.tmp')
  try {
    await downloadFile(fileUrl, tempFilePath)
    const pdfBuffer = await fsPromises.readFile(tempFilePath)
    const pdfData = await pdfParse(pdfBuffer)
    const format = getEbupotFormatedSignature(pdfData.text)
    const data = extractEbupot(pdfData.text, format)
    reply.send({ format, data })
  } catch (error: any) {
    console.error(`Download or PDF parsing failed: ${error.message}`)
    reply.status(500).send({ error: 'Error processing request' })
  } finally {
    await fsPromises.unlink(tempFilePath)
    await fsPromises.rmdir(tempDir)
  }
}

function setupRoutes(server: FastifyInstance): void {
  server.get('*', handleMainRoute)
  server.get('/', (_req, reply) => reply.send('Server is running'))
}

// Initialize and start the server
server.addHook('preHandler', authenticateRequest)
setupRoutes(server)
server.listen({ port: +environment.port, host: '0.0.0.0' }, (err) => {
  if (err) {
    console.error('Error starting server:', err)
    process.exit(1)
  }
})
