#!/usr/bin/env python3
"""Valida um pedido do dashboard e substitui a agenda partilhada epe.csv."""

from __future__ import annotations

import csv
import io
import json
import os
import re
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from zoneinfo import ZoneInfo


TIMEZONE_NAME = "Europe/Lisbon"
TIMEZONE = ZoneInfo(TIMEZONE_NAME)
AUTHORIZED_ASSOCIATIONS = {"OWNER", "MEMBER", "COLLABORATOR"}
LEVELS = {"NORMAL", "I", "II", "III", "IV"}
CHANGE_TYPES = {
    "ELEVACAO": "Elevação",
    "MANUTENCAO": "Manutenção",
    "DESAGRAVAMENTO": "Desagravamento",
}
PAYLOAD_PATTERN = re.compile(
    r"<!--\s*EPE_REQUEST_V1\s*(\{.*?\})\s*-->",
    flags=re.DOTALL,
)
ERROR_OUTPUT_PATH = Path(".epe-validation-error.txt")


class RequestError(ValueError):
    """Erro de validação seguro para apresentar no registo da Action."""


@dataclass(frozen=True)
class Schedule:
    identifier: str
    level: str
    change_type: str
    start: datetime
    end: datetime


def parse_local_datetime(value: object, field_name: str) -> datetime:
    text = str(value or "").strip()

    try:
        naive = datetime.strptime(text, "%Y-%m-%dT%H:%M")
    except ValueError as exc:
        raise RequestError(
            f"{field_name}: use o formato AAAA-MM-DDTHH:MM."
        ) from exc

    valid_offsets = set()
    valid_candidates = []
    for fold in (0, 1):
        candidate = naive.replace(tzinfo=TIMEZONE, fold=fold)
        round_trip = candidate.astimezone(UTC).astimezone(TIMEZONE)
        if round_trip.replace(tzinfo=None) == naive:
            valid_offsets.add(candidate.utcoffset())
            valid_candidates.append(candidate)

    if not valid_candidates:
        raise RequestError(
            f"{field_name}: a hora não existe devido à mudança da hora legal."
        )

    if len(valid_offsets) > 1:
        raise RequestError(
            f"{field_name}: a hora é ambígua devido à mudança da hora legal."
        )

    return valid_candidates[0]


def extract_payload(body: object) -> dict:
    match = PAYLOAD_PATTERN.search(str(body or ""))
    if not match:
        raise RequestError("O pedido não contém o bloco de dados EPE esperado.")

    try:
        payload = json.loads(match.group(1))
    except json.JSONDecodeError as exc:
        raise RequestError("O bloco de dados EPE não é JSON válido.") from exc

    if not isinstance(payload, dict):
        raise RequestError("O bloco de dados EPE tem uma estrutura inválida.")

    return payload


def validate_payload(payload: dict, now: datetime | None = None) -> list[Schedule]:
    if payload.get("versao") != 1:
        raise RequestError("A versão do pedido EPE não é suportada.")

    if payload.get("timezone") != TIMEZONE_NAME:
        raise RequestError("O pedido tem de usar o fuso horário Europe/Lisbon.")

    entries = payload.get("agendamentos")
    if not isinstance(entries, list):
        raise RequestError("A lista de agendamentos está em falta.")

    if len(entries) > 3:
        raise RequestError("Só podem existir até três determinações EPE.")

    current_time = now or datetime.now(TIMEZONE)
    schedules: list[Schedule] = []

    for index, entry in enumerate(entries, start=1):
        if not isinstance(entry, dict):
            raise RequestError(f"Determinação {index}: estrutura inválida.")

        level = str(entry.get("nivel") or "").strip().upper()
        change_type = str(entry.get("tipo") or "").strip().upper()

        if level not in LEVELS:
            raise RequestError(
                f"Determinação {index}: nível deve ser Normal, I, II, III ou IV."
            )
        if change_type not in CHANGE_TYPES:
            raise RequestError(
                f"Determinação {index}: alteração deve ser Elevação, "
                "Manutenção ou Desagravamento."
            )

        start = parse_local_datetime(entry.get("inicio"), f"Determinação {index}, início")
        end = parse_local_datetime(entry.get("fim"), f"Determinação {index}, fim")

        if end <= start:
            raise RequestError(
                f"Determinação {index}: o fim tem de ser posterior ao início."
            )
        if end <= current_time:
            raise RequestError(
                f"Determinação {index}: o período já terminou."
            )

        schedules.append(
            Schedule(
                identifier=f"epe-{index}",
                level=level,
                change_type=change_type,
                start=start,
                end=end,
            )
        )

    schedules.sort(key=lambda schedule: schedule.start)
    for previous, current in zip(schedules, schedules[1:]):
        if current.start < previous.end:
            raise RequestError(
                "Os períodos não podem sobrepor-se; o seguinte só pode começar "
                "quando o anterior terminar."
            )

    return schedules


def build_csv(schedules: list[Schedule], now: datetime | None = None) -> str:
    current_time = now or datetime.now(TIMEZONE)
    stream = io.StringIO(newline="")
    stream.write("sep=;\n")
    writer = csv.writer(stream, delimiter=";", lineterminator="\n")
    writer.writerow(
        [
            "id",
            "tipo",
            "nivel",
            "data_inicio",
            "hora_inicio",
            "data_fim",
            "hora_fim",
            "inicio_iso",
            "fim_iso",
            "situacao",
        ]
    )

    for schedule in schedules:
        situation = "Em vigor" if schedule.start <= current_time < schedule.end else "Agendada"
        writer.writerow(
            [
                schedule.identifier,
                CHANGE_TYPES[schedule.change_type],
                schedule.level,
                schedule.start.strftime("%Y-%m-%d"),
                schedule.start.strftime("%H:%M"),
                schedule.end.strftime("%Y-%m-%d"),
                schedule.end.strftime("%H:%M"),
                schedule.start.isoformat(timespec="seconds"),
                schedule.end.isoformat(timespec="seconds"),
                situation,
            ]
        )

    return stream.getvalue()


def process_event(event: dict, output_path: Path) -> int:
    issue = event.get("issue") or {}
    association = str(issue.get("author_association") or "").upper()

    if association not in AUTHORIZED_ASSOCIATIONS:
        raise RequestError(
            "O autor não é proprietário, membro ou colaborador autorizado do repositório."
        )

    payload = extract_payload(issue.get("body"))
    schedules = validate_payload(payload)
    output_path.write_text(build_csv(schedules), encoding="utf-8", newline="")
    return len(schedules)


def main() -> int:
    event_path = os.environ.get("GITHUB_EVENT_PATH")
    if not event_path:
        print("GITHUB_EVENT_PATH não está definido.", file=sys.stderr)
        return 1

    try:
        event = json.loads(Path(event_path).read_text(encoding="utf-8"))
        count = process_event(event, Path("epe.csv"))
    except (OSError, json.JSONDecodeError, RequestError) as exc:
        message = str(exc)
        print(f"Pedido EPE recusado: {message}", file=sys.stderr)
        try:
            ERROR_OUTPUT_PATH.write_text(message, encoding="utf-8")
        except OSError:
            pass
        return 1

    print(f"Agenda EPE validada: {count} determinação(ões).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
