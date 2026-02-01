#!/usr/bin/env python3
"""
Discord 泄露者追踪器 - 使用二分法定位信息泄露者
"""

import discord
import asyncio
import json
import sys
import argparse
import math
from typing import Optional, List, Dict, Any


def output_progress(step: int, total: int, remaining: int, message: str):
    """输出进度信息"""
    data = {
        "step": step,
        "total": total,
        "remaining": remaining,
        "message": message
    }
    print(f"PROGRESS:{json.dumps(data)}", flush=True)


def output_result(leaker: Dict[str, Any]):
    """输出结果"""
    print(f"RESULT:{json.dumps(leaker)}", flush=True)


class LeakerTracker:
    """泄露者追踪器"""

    def __init__(self, config: Dict[str, Any]):
        self.token = config["token"]
        self.server_id = int(config["server_id"])
        self.role_ids = [int(r) for r in config["role_ids"]]
        self.target_channel_id = int(config["target_channel_id"])
        self.test_message = config["test_message"]
        self.timeout = float(config.get("timeout", 10))

        self.client = discord.Client()
        self.guild: Optional[discord.Guild] = None
        self.target_channel: Optional[discord.TextChannel] = None
        self.members_with_roles: List[discord.Member] = []
        self.found_leaker: Optional[discord.Member] = None
        self.message_detected = False

    async def get_members_with_roles(self) -> List[discord.Member]:
        """获取拥有指定身份组的所有成员"""
        members = []
        for member in self.guild.members:
            for role in member.roles:
                if role.id in self.role_ids:
                    members.append(member)
                    break
        return members

    async def remove_roles_from_members(self, members: List[discord.Member]) -> Dict[int, List[discord.Role]]:
        """移除成员的身份组，返回原始身份组映射"""
        original_roles = {}
        for member in members:
            roles_to_remove = [r for r in member.roles if r.id in self.role_ids]
            if roles_to_remove:
                original_roles[member.id] = roles_to_remove
                for role in roles_to_remove:
                    try:
                        await member.remove_roles(role)
                    except Exception as e:
                        output_progress(0, 0, 0, f"移除身份组失败: {e}")
        return original_roles

    async def restore_roles(self, original_roles: Dict[int, List[discord.Role]]):
        """恢复成员的身份组"""
        for member_id, roles in original_roles.items():
            member = self.guild.get_member(member_id)
            if member:
                for role in roles:
                    try:
                        await member.add_roles(role)
                    except Exception as e:
                        output_progress(0, 0, 0, f"恢复身份组失败: {e}")

    async def wait_for_leak(self, timeout: float = 30.0) -> bool:
        """等待目标频道出现泄露消息"""
        self.message_detected = False

        def check_message(message: discord.Message) -> bool:
            if message.channel.id != self.target_channel_id:
                return False
            content = message.content
            if message.embeds:
                for embed in message.embeds:
                    if embed.description:
                        content += embed.description
                    if embed.title:
                        content += embed.title
            return self.test_message in content

        try:
            await asyncio.wait_for(
                self.client.wait_for('message', check=check_message),
                timeout=timeout
            )
            self.message_detected = True
            return True
        except asyncio.TimeoutError:
            return False

    async def send_test_message(self, channel: discord.TextChannel):
        """发送测试消息"""
        await channel.send(self.test_message)

    async def binary_search(self, suspects: List[discord.Member],
                           test_channel: discord.TextChannel,
                           step: int = 1) -> Optional[discord.Member]:
        """二分搜索找出泄露者"""
        total_steps = math.ceil(math.log2(len(suspects))) + 1 if suspects else 0

        output_progress(step, total_steps, len(suspects),
                       f"当前嫌疑人数: {len(suspects)}")

        if len(suspects) == 0:
            return None

        if len(suspects) == 1:
            output_progress(step, total_steps, 1,
                           f"找到泄露者: {suspects[0].name}")
            return suspects[0]

        mid = len(suspects) // 2
        first_half = suspects[:mid]
        second_half = suspects[mid:]

        output_progress(step, total_steps, len(suspects),
                       f"移除前半部分 {len(first_half)} 人的身份组...")

        removed_roles = await self.remove_roles_from_members(first_half)
        await asyncio.sleep(1)

        output_progress(step, total_steps, len(suspects),
                       "发送测试消息...")
        await self.send_test_message(test_channel)

        output_progress(step, total_steps, len(suspects),
                       f"等待泄露消息 ({self.timeout}秒)...")
        leaked = await self.wait_for_leak(timeout=self.timeout)

        output_progress(step, total_steps, len(suspects),
                       "恢复身份组...")
        await self.restore_roles(removed_roles)

        if leaked:
            output_progress(step, total_steps, len(second_half),
                           f"泄露者在后半部分 ({len(second_half)} 人)")
            return await self.binary_search(second_half, test_channel, step + 1)
        else:
            output_progress(step, total_steps, len(first_half),
                           f"泄露者在前半部分 ({len(first_half)} 人)")
            return await self.binary_search(first_half, test_channel, step + 1)

    async def run(self):
        """运行追踪器"""
        @self.client.event
        async def on_ready():
            output_progress(0, 0, 0, f"已登录: {self.client.user}")

            self.guild = self.client.get_guild(self.server_id)
            if not self.guild:
                output_progress(0, 0, 0, "错误: 找不到服务器")
                await self.client.close()
                return

            output_progress(0, 0, 0, f"服务器: {self.guild.name}")

            self.members_with_roles = await self.get_members_with_roles()
            output_progress(0, 0, len(self.members_with_roles),
                           f"找到 {len(self.members_with_roles)} 个会员")

            if len(self.members_with_roles) == 0:
                output_progress(0, 0, 0, "错误: 没有找到拥有指定身份组的成员")
                await self.client.close()
                return

            test_channel = self.guild.text_channels[0] if self.guild.text_channels else None
            if not test_channel:
                output_progress(0, 0, 0, "错误: 服务器没有文字频道")
                await self.client.close()
                return

            output_progress(0, 0, len(self.members_with_roles),
                           "开始二分搜索...")

            leaker = await self.binary_search(
                self.members_with_roles,
                test_channel
            )

            if leaker:
                self.found_leaker = leaker
                leaker_roles = [r.name for r in leaker.roles if r.name != "@everyone"]
                avatar_url = str(leaker.avatar.url) if leaker.avatar else ""

                output_result({
                    "id": str(leaker.id),
                    "username": leaker.name,
                    "display_name": leaker.display_name,
                    "avatar": avatar_url,
                    "roles": leaker_roles
                })
            else:
                output_progress(0, 0, 0, "未找到泄露者")

            await self.client.close()

        await self.client.start(self.token)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args()

    config = json.loads(args.config)
    tracker = LeakerTracker(config)
    asyncio.run(tracker.run())


if __name__ == "__main__":
    main()
