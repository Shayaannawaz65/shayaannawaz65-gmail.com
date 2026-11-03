#!/usr/bin/env python3
import argparse
import base64
import getpass
import json
import subprocess
import os
import sys
from pathlib import Path

from cryptography.exceptions import InvalidSignature, InvalidTag
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

MAGIC = b"T2TE1"
SALT_LEN = 16
NONCE_LEN = 12
AAD = b"T2T-CRYPTO-FILE-V1"
MAX_FILE_SIZE = 256 * 1024 * 1024


def write_new(path, data, mode=0o600):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
    except Exception:
        path.unlink(missing_ok=True)
        raise


def read_file(path):
    data = Path(path).read_bytes()
    if len(data) > MAX_FILE_SIZE:
        raise ValueError("File exceeds 256 MiB safety limit")
    return data


def password(confirm=False):
    first = getpass.getpass("Passphrase (input hidden): ")
    if len(first) < 12:
        raise ValueError("Passphrase must contain at least 12 characters")
    if confirm:
        second = getpass.getpass("Confirm passphrase: ")
        if first != second:
            raise ValueError("Passphrases do not match")
    return first.encode("utf-8")


def derive_file_key(passphrase_bytes, salt):
    master = Scrypt(
        salt=salt, length=32, n=2**15, r=8, p=1
    ).derive(passphrase_bytes)
    return HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        info=AAD
    ).derive(master)


def cmd_keygen(args):
    out = Path(args.out_dir)
    private_path = out / f"{args.name}-private.pem"
    public_path = out / f"{args.name}-public.pem"

    if private_path.exists() or public_path.exists():
        raise FileExistsError("Key file already exists; refusing to overwrite")

    secret = password(confirm=True)
    private_key = ec.generate_private_key(ec.SECP256R1())

    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.BestAvailableEncryption(secret)
    )
    public_pem = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo
    )

    write_new(private_path, private_pem, 0o600)
    try:
        write_new(public_path, public_pem, 0o644)
    except Exception:
        private_path.unlink(missing_ok=True)
        raise

    print("P-256 key pair created.")
    print(f"Encrypted private key: {private_path}")
    print(f"Public key:            {public_path}")
    print("Keep the private key secret. Register only the public key with T2T.")


def cmd_sign(args):
    secret = password()
    key_data = Path(args.key).read_bytes()
    private_key = serialization.load_pem_private_key(
        key_data, password=secret
    )
    if not isinstance(private_key, ec.EllipticCurvePrivateKey):
        raise ValueError("Key is not an EC private key")
    if not isinstance(private_key.curve, ec.SECP256R1):
        raise ValueError("Only P-256 keys are accepted")

    signature = private_key.sign(
        read_file(args.input), ec.ECDSA(hashes.SHA256())
    )
    encoded = base64.b64encode(signature) + b"\n"
    output = args.output or (args.input + ".sig")
    write_new(output, encoded)
    print(f"SHA-256 / ECDSA signature written: {output}")


def cmd_verify(args):
    public_key = serialization.load_pem_public_key(
        Path(args.public_key).read_bytes()
    )
    if not isinstance(public_key, ec.EllipticCurvePublicKey):
        raise ValueError("Key is not an EC public key")
    if not isinstance(public_key.curve, ec.SECP256R1):
        raise ValueError("Only P-256 keys are accepted")

    signature = base64.b64decode(
        Path(args.signature).read_bytes().strip(), validate=True
    )
    try:
        public_key.verify(
            signature, read_file(args.input), ec.ECDSA(hashes.SHA256())
        )
    except InvalidSignature:
        print("FAIL: signature is invalid or file was changed.")
        return 2

    print("PASS: signature verified; file integrity confirmed.")
    return 0


def cmd_encrypt(args):
    data = read_file(args.input)
    secret = password(confirm=True)
    salt = os.urandom(SALT_LEN)
    nonce = os.urandom(NONCE_LEN)
    key = derive_file_key(secret, salt)
    header = MAGIC + salt + nonce
    ciphertext = AESGCM(key).encrypt(nonce, data, header + AAD)
    output = args.output or (args.input + ".t2te")
    write_new(output, header + ciphertext)
    print(f"AES-256-GCM encrypted file written: {output}")


def cmd_decrypt(args):
    blob = read_file(args.input)
    header_len = len(MAGIC) + SALT_LEN + NONCE_LEN
    if len(blob) < header_len + 16 or not blob.startswith(MAGIC):
        raise ValueError("Invalid T2T encrypted-file format")

    salt_start = len(MAGIC)
    salt = blob[salt_start:salt_start + SALT_LEN]
    nonce_start = salt_start + SALT_LEN
    nonce = blob[nonce_start:nonce_start + NONCE_LEN]
    header = blob[:header_len]
    ciphertext = blob[header_len:]

    secret = password()
    key = derive_file_key(secret, salt)
    try:
        plaintext = AESGCM(key).decrypt(nonce, ciphertext, header + AAD)
    except InvalidTag:
        raise ValueError("Decryption failed: wrong passphrase or modified file")

    output = args.output or (args.input[:-5] if args.input.endswith(".t2te")
                             else args.input + ".decrypted")
    write_new(output, plaintext)
    print(f"Authenticated decryption successful: {output}")


def cmd_hash(args):
    digest = hashes.Hash(hashes.SHA256())
    digest.update(read_file(args.input))
    print(digest.finalize().hex())



def js_string(value):
    if value is None:
        return ""
    if value is False:
        return "false"
    if value is True:
        return "true"
    return str(value)


def js_truthy_string(value):
    if value is None or value is False or value == "" or value == 0:
        return ""
    return js_string(value)


def js_metadata_hash(quote):
    metadata = quote.get("rateMetadata") if isinstance(quote, dict) else None
    encoded = json.dumps(metadata, ensure_ascii=False, separators=(",", ":"),
                         allow_nan=False)
    result = subprocess.run(
        ["node", "-e",
         "let s='';process.stdin.setEncoding('utf8');"
         "process.stdin.on('data',d=>s+=d);"
         "process.stdin.on('end',()=>process.stdout.write("
         "JSON.stringify(JSON.parse(s))));"],
        input=encoded, text=True, capture_output=True, check=True
    )
    return __import__("hashlib").sha256(
        result.stdout.encode("utf-8")
    ).hexdigest()


def load_s2s_body(path):
    body = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(body, dict):
        raise ValueError("Request body must be a JSON object")
    return body


def cmd_sign_s2s(args):
    body = load_s2s_body(args.body)
    secret = password()
    private_key = serialization.load_pem_private_key(
        Path(args.key).read_bytes(), password=secret
    )
    if not isinstance(private_key, ec.EllipticCurvePrivateKey):
        raise ValueError("Key is not an EC private key")
    if not isinstance(private_key.curve, ec.SECP256R1):
        raise ValueError("Only P-256 keys are accepted")

    terminal = body.get("terminalId")
    terminal_id = "" if terminal is None or terminal == "" else js_string(terminal)

    timestamp = body.get("timestamp")
    if isinstance(timestamp, bool) or not isinstance(timestamp, (int, float)):
        raise ValueError("timestamp must be numeric")
    if not float(timestamp).is_integer() or abs(timestamp) > 9007199254740991:
        raise ValueError("timestamp must be a safe integer")

    nonce = js_truthy_string(body.get("nonce"))
    invoice = js_truthy_string(body.get("invoiceReference"))
    cents = body.get("amountUsdCents")
    cents = "" if cents is None else js_string(cents)

    common = [
        args.key_id,
        args.client_id,
        terminal_id,
        js_string(int(timestamp)),
        nonce,
        invoice,
        cents
    ]

    if args.protocol == "quote":
        canonical = ["T2T_S2S_PAYMENT_QUOTE_V2", *common]
    else:
        quote = body.get("quote")
        if quote is not None and not isinstance(quote, dict):
            raise ValueError("quote must be a JSON object")
        quote = quote or {}
        raw_amount = js_truthy_string(body.get("amountUsdtRaw"))
        expiry = body.get("expiresInSeconds")
        metadata_hash = js_metadata_hash(quote)

        canonical = [
            "T2T_S2S_PAYMENT_ORDER_V2",
            *common,
            raw_amount,
            js_string(expiry),
            js_truthy_string(quote.get("quoteId")),
            js_truthy_string(quote.get("rateNumerator")),
            js_truthy_string(quote.get("rateDenominator")),
            js_truthy_string(quote.get("expiresAt")),
            js_truthy_string(quote.get("signature")),
            metadata_hash
        ]

    message = "\n".join(canonical).encode("utf-8")
    signature = private_key.sign(message, ec.ECDSA(hashes.SHA256()))
    encoded = base64.b64encode(signature).decode("ascii")

    if args.output:
        write_new(args.output, (encoded + "\n").encode("ascii"))
        print(f"Signature saved: {args.output}")
    else:
        print("X-T2T-Key-ID:", args.key_id)
        print("X-T2T-Signature:", encoded)

    print("Protocol:", args.protocol.upper(), "V2")
    print("Canonical SHA-256:", __import__("hashlib").sha256(message).hexdigest())


def build_parser():
    parser = argparse.ArgumentParser(
        prog="t2t-crypto",
        description="T2T cryptographic terminal utility"
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("keygen", help="Generate encrypted P-256 key pair")
    p.add_argument("--name", default="t2t-s2s")
    p.add_argument("--out-dir", default="secure-keys")
    p.set_defaults(func=cmd_keygen)

    p = sub.add_parser("sign", help="Sign a file using P-256 / SHA-256")
    p.add_argument("--key", required=True)
    p.add_argument("--input", required=True)
    p.add_argument("--output")
    p.set_defaults(func=cmd_sign)

    p = sub.add_parser("verify", help="Verify a P-256 signature")
    p.add_argument("--public-key", required=True)
    p.add_argument("--input", required=True)
    p.add_argument("--signature", required=True)
    p.set_defaults(func=cmd_verify)

    p = sub.add_parser("encrypt", help="Encrypt a file with AES-256-GCM")
    p.add_argument("--input", required=True)
    p.add_argument("--output")
    p.set_defaults(func=cmd_encrypt)

    p = sub.add_parser("decrypt", help="Authenticate and decrypt a T2T file")
    p.add_argument("--input", required=True)
    p.add_argument("--output")
    p.set_defaults(func=cmd_decrypt)

    for protocol in ("quote", "order"):
        p = sub.add_parser(
            "sign-" + protocol,
            help="Sign exact T2T S2S " + protocol + " V2 request"
        )
        p.add_argument("--key", required=True)
        p.add_argument("--key-id", required=True)
        p.add_argument("--client-id", required=True)
        p.add_argument("--body", required=True)
        p.add_argument("--output")
        p.set_defaults(func=cmd_sign_s2s, protocol=protocol)

    p = sub.add_parser("hash", help="Calculate a SHA-256 file digest")
    p.add_argument("--input", required=True)
    p.set_defaults(func=cmd_hash)
    return parser


if __name__ == "__main__":
    try:
        args = build_parser().parse_args()
        result = args.func(args)
        sys.exit(result if isinstance(result, int) else 0)
    except (ValueError, OSError, TypeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
