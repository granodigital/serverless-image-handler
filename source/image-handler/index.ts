// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import Rekognition from "aws-sdk/clients/rekognition";
import S3 from "aws-sdk/clients/s3";
import SecretsManager from "aws-sdk/clients/secretsmanager";

import { getOptions } from "../solution-utils/get-options";
import { isNullOrWhiteSpace } from "../solution-utils/helpers";
import { ImageHandler } from "./image-handler";
import { ImageRequest } from "./image-request";
import { Headers, ImageHandlerEvent, ImageHandlerExecutionResult, RequestTypes, StatusCodes } from "./lib";
import { SecretProvider } from "./secret-provider";

const awsSdkOptions = getOptions();
const s3Client = new S3(awsSdkOptions);
const rekognitionClient = new Rekognition(awsSdkOptions);
const secretsManagerClient = new SecretsManager(awsSdkOptions);
const secretProvider = new SecretProvider(secretsManagerClient);

/**
 * Image handler Lambda handler.
 * @param event The image handler request event.
 * @returns Processed request response.
 */
export async function handler(event: ImageHandlerEvent): Promise<ImageHandlerExecutionResult> {
  console.info("Received event:", JSON.stringify(event, null, 2));

  const imageRequest = new ImageRequest(s3Client, secretProvider);
  const imageHandler = new ImageHandler(s3Client, rekognitionClient);
  const isAlb = event.requestContext && Object.prototype.hasOwnProperty.call(event.requestContext, "elb");

  try {
    const imageRequestInfo = await imageRequest.setup(event);
    console.info(imageRequestInfo);

    const processedRequest = await imageHandler.process(imageRequestInfo);

    let headers: Headers = {};
    // Define headers that can be overwritten
    headers["Cache-Control"] = imageRequestInfo.cacheControl;

    // Apply the custom headers
    if (imageRequestInfo.headers) {
      headers = { ...headers, ...imageRequestInfo.headers };
    }

    headers = { ...headers, ...getResponseHeaders(false, isAlb) };
    headers["Content-Type"] = imageRequestInfo.contentType;
    headers["Expires"] = imageRequestInfo.expires;
    headers["Last-Modified"] = imageRequestInfo.lastModified;

    return {
      statusCode: StatusCodes.OK,
      isBase64Encoded: true,
      headers,
      body: processedRequest,
    };
  } catch (error) {
    console.error(error);

    // Default fallback image
    const { ENABLE_DEFAULT_FALLBACK_IMAGE, DEFAULT_FALLBACK_IMAGE_BUCKET, DEFAULT_FALLBACK_IMAGE_KEY } = process.env;
    if (
      ENABLE_DEFAULT_FALLBACK_IMAGE === "Yes" &&
      !isNullOrWhiteSpace(DEFAULT_FALLBACK_IMAGE_BUCKET) &&
      !isNullOrWhiteSpace(DEFAULT_FALLBACK_IMAGE_KEY)
    ) {
      try {
        return await handleDefaultFallbackImage(imageRequest, event, isAlb, error);
      } catch (error) {
        console.error("Error occurred while getting the default fallback image.", error);
      }
    }

    const { statusCode, body } = getErrorResponse(error);
    return {
      statusCode,
      isBase64Encoded: false,
      headers: getResponseHeaders(true, isAlb),
      body,
    };
  }
}

/**
 * Retrieve the default fallback image and construct the ImageHandlerExecutionResult
 * @param imageRequest The ImageRequest object
 * @param event The Lambda Event object
 * @param isAlb Whether we're behind an ALB
 * @param error The error that resulted in us getting the fallback image
 * @returns Processed request response for fallback image
 * @
 */
export async function handleDefaultFallbackImage(
  imageRequest: ImageRequest,
  event: ImageHandlerEvent,
  isAlb: boolean,
  error
): Promise<ImageHandlerExecutionResult> {
  const { DEFAULT_FALLBACK_IMAGE_BUCKET, DEFAULT_FALLBACK_IMAGE_KEY } = process.env;
  const defaultFallbackImage = await s3Client
    .getObject({
      Bucket: DEFAULT_FALLBACK_IMAGE_BUCKET,
      Key: DEFAULT_FALLBACK_IMAGE_KEY,
    })
    .promise();

  const headers = getResponseHeaders(false, isAlb);
  headers["Content-Type"] = defaultFallbackImage.ContentType;
  headers["Last-Modified"] = defaultFallbackImage.LastModified;
  try {
    headers["Cache-Control"] = imageRequest.parseImageHeaders(event, RequestTypes.DEFAULT)?.["Cache-Control"];
  } catch {}

  // Prioritize Cache-Control header attached to the fallback image followed by Cache-Control header provided in request, followed by the default
  headers["Cache-Control"] = defaultFallbackImage.CacheControl ?? headers["Cache-Control"] ?? "max-age=31536000,public";

  return {
    statusCode: error.status ? error.status : StatusCodes.INTERNAL_SERVER_ERROR,
    isBase64Encoded: true,
    headers,
    body: defaultFallbackImage.Body.toString("base64"),
  };
}

/**
 * Generates the appropriate set of response headers based on a success or error condition.
 * @param isError Has an error been thrown.
 * @param isAlb Is the request from ALB.
 * @returns Headers.
 */
function getResponseHeaders(isError: boolean = false, isAlb: boolean = false): Headers {
  const { CORS_ENABLED, CORS_ORIGIN } = process.env;
  const corsEnabled = CORS_ENABLED === "Yes";
  const headers: Headers = {
    "Access-Control-Allow-Methods": "GET",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  if (!isAlb) {
    headers["Access-Control-Allow-Credentials"] = true;
  }

  if (corsEnabled) {
    headers["Access-Control-Allow-Origin"] = CORS_ORIGIN;
  }

  if (isError) {
    headers["Content-Type"] = "application/json";
  }

  return headers;
}

/**
 * Determines the appropriate error response values
 * @param error The error object from a try/catch block
 * @returns appropriate status code and body
 */
export function getErrorResponse(error) {
  if (error?.status) {
    return {
      statusCode: error.status,
      body: JSON.stringify(error),
    };
  }
  /**
   * if an image overlay is attempted and the overlaying image has greater dimensions
   * that the base image, sharp will throw an exception and return this string
   */
  if (error?.message === "Image to composite must have same dimensions or smaller") {
    return {
      statusCode: StatusCodes.BAD_REQUEST,
      body: JSON.stringify({
        /**
         * return a message indicating overlay dimensions is the issue, the caller may not
         * know that the sharp composite function was used
         */
        message: "Image to overlay must have same dimensions or smaller",
        code: "BadRequest",
        status: StatusCodes.BAD_REQUEST,
      }),
    };
  }
  return {
    statusCode: StatusCodes.INTERNAL_SERVER_ERROR,
    body: JSON.stringify({
      message: "Internal error. Please contact the system administrator.",
      code: "InternalError",
      status: StatusCodes.INTERNAL_SERVER_ERROR,
    }),
  };
}
