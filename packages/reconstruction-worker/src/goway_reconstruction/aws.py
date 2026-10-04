"""The worker's only network surface: outbound HTTPS to S3 and SQS.

There is no listening socket anywhere in this package. Credentials come from the
configured AWS profile, which on a worker host is a credential process that
exchanges a certificate for short-lived role credentials (IAM Roles Anywhere);
no long-lived key is read from this repository or from the worker config.

The role can receive/extend/delete on the jobs queue, send to the events
queue, read ``captures/``, ``derived/`` and ``jobs/`` and write only
``derived/`` and ``jobs/``. Nothing here assumes more than that.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from .config import WorkerConfig


class IntegrityError(RuntimeError):
    """Downloaded bytes are not the bytes the job named."""


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


@dataclass
class Message:
    receipt: str
    body: dict
    receive_count: int
    # The backend's attempt number. A backend retry is a NEW message (its
    # receive count starts at 1 again), so the attempt travels as a message
    # attribute; a redelivery of the same message keeps the same attempt.
    attempt: int


class Aws:
    def __init__(self, config: WorkerConfig) -> None:
        session = boto3.Session(profile_name=config.aws_profile, region_name=config.region)
        retry = Config(retries={"max_attempts": 8, "mode": "adaptive"}, connect_timeout=10, read_timeout=60)
        self.s3 = session.client("s3", config=retry)
        self.sqs = session.client("sqs", config=retry)
        self.sts = session.client("sts", config=retry)
        self.config = config
        self.bytes_downloaded = 0

    # ── S3 ──────────────────────────────────────────────────────────────────

    def download(self, key: str, dest: Path, *, sha256: str, byte_size: int | None = None) -> None:
        """Stream ``key`` to ``dest`` and refuse it unless it hashes to ``sha256``."""
        dest.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=dest.parent, prefix=".part-")
        digest = hashlib.sha256()
        size = 0
        try:
            body = self.s3.get_object(Bucket=self.config.bucket, Key=key)["Body"]
            with os.fdopen(fd, "wb") as out:
                for chunk in iter(lambda: body.read(1 << 20), b""):
                    digest.update(chunk)
                    out.write(chunk)
                    size += len(chunk)
            self.bytes_downloaded += size
            if digest.hexdigest() != sha256 or (byte_size is not None and size != byte_size):
                raise IntegrityError("object does not match the digest the job named")
            os.replace(tmp, dest)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

    def get_json(self, key: str, *, sha256: str | None = None, max_bytes: int = 8 << 20) -> dict:
        obj = self.s3.get_object(Bucket=self.config.bucket, Key=key)
        if obj["ContentLength"] > max_bytes:
            raise IntegrityError("document is larger than allowed")
        data = obj["Body"].read()
        self.bytes_downloaded += len(data)
        if sha256 is not None and sha256_bytes(data) != sha256:
            raise IntegrityError("document does not match the digest the job named")
        return json.loads(data)

    def put(self, key: str, data: bytes, content_type: str) -> tuple[str, int]:
        """Upload with an S3-verified SHA-256; returns (hex digest, size)."""
        digest = hashlib.sha256(data)
        self.s3.put_object(
            Bucket=self.config.bucket,
            Key=key,
            Body=data,
            ContentType=content_type,
            ChecksumSHA256=base64.b64encode(digest.digest()).decode(),
        )
        return digest.hexdigest(), len(data)

    def exists(self, key: str) -> bool:
        try:
            self.s3.head_object(Bucket=self.config.bucket, Key=key)
            return True
        except ClientError as error:
            if error.response.get("Error", {}).get("Code") in ("404", "NoSuchKey", "NotFound"):
                return False
            raise

    # ── SQS ─────────────────────────────────────────────────────────────────

    def receive(self, wait_seconds: int = 20) -> Message | None:
        response = self.sqs.receive_message(
            QueueUrl=self.config.jobs_queue_url,
            MaxNumberOfMessages=1,
            WaitTimeSeconds=wait_seconds,
            VisibilityTimeout=self.config.visibility_timeout_seconds,
            MessageSystemAttributeNames=["ApproximateReceiveCount"],
            MessageAttributeNames=["attempt"],
        )
        for raw in response.get("Messages", []):
            try:
                body = json.loads(raw["Body"])
            except json.JSONDecodeError:
                body = {}
            receive_count = int(raw.get("Attributes", {}).get("ApproximateReceiveCount", "1"))
            attempt_attr = raw.get("MessageAttributes", {}).get("attempt", {}).get("StringValue", "")
            return Message(
                receipt=raw["ReceiptHandle"],
                body=body,
                receive_count=receive_count,
                attempt=int(attempt_attr) if attempt_attr.isdigit() else receive_count,
            )
        return None

    def extend(self, message: Message, seconds: int) -> None:
        self.sqs.change_message_visibility(
            QueueUrl=self.config.jobs_queue_url, ReceiptHandle=message.receipt, VisibilityTimeout=seconds
        )

    def delete(self, message: Message) -> None:
        self.sqs.delete_message(QueueUrl=self.config.jobs_queue_url, ReceiptHandle=message.receipt)

    def emit(self, event: dict) -> None:
        self.sqs.send_message(QueueUrl=self.config.events_queue_url, MessageBody=json.dumps(event, separators=(",", ":")))

    def queue_depth(self) -> dict[str, int]:
        attrs = self.sqs.get_queue_attributes(
            QueueUrl=self.config.jobs_queue_url,
            AttributeNames=["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
        )["Attributes"]
        return {"pending": int(attrs["ApproximateNumberOfMessages"]), "inFlight": int(attrs["ApproximateNumberOfMessagesNotVisible"])}
