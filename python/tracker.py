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
import aiohttp
from typing import Optional, List, Dict, Any


def output_progress(step: int, total: int, remaining: int, message: str, names: List[str] = None):
    """输出进度信息"""
    data = {
        "step": step,
        "total": total,
        "remaining": remaining,
        "message": message,
        "names": names or []
    }
    print(f"PROGRESS:{json.dumps(data)}", flush=True)


def output_result(leaker: Dict[str, Any]):
    """输出结果"""
    print(f"RESULT:{json.dumps(leaker)}", flush=True)


class LeakerTracker:
    """泄露者追踪器"""

    def __init__(self, config: Dict[str, Any]):
        self.token = config["token"]
        self.server_id = int(config["serverId"])
        self.role_ids = [int(r) for r in config["roleIds"]]
        self.target_channel_id = int(config["targetChannelId"])
        self.test_message = config["testMessage"]
        self.timeout = float(config.get("timeout", 10))
        self.webhook_url = config.get("webhookUrl", "")
        self.send_channel_id = int(config["sendChannelId"]) if config.get("sendChannelId") else None

        # discord.py-self 不需要 intents，用户账号可以直接访问所有数据
        self.client = discord.Client()
        self.guild: Optional[discord.Guild] = None
        self.target_channel: Optional[discord.TextChannel] = None
        self.send_channel: Optional[discord.TextChannel] = None
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
                    except discord.Forbidden as e:
                        output_progress(0, 0, 0, f"【错误】移除身份组失败: 权限不足 - {e}")
                        raise Exception(f"权限不足，无法移除身份组: {e}")
                    except Exception as e:
                        output_progress(0, 0, 0, f"【错误】移除身份组失败: {e}")
                        raise Exception(f"移除身份组失败: {e}")
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

    async def send_test_message(self):
        """发送测试消息（通过webhook或账号）"""
        if self.webhook_url:
            # 使用webhook发送
            async with aiohttp.ClientSession() as session:
                payload = {"content": self.test_message}
                async with session.post(self.webhook_url, json=payload) as resp:
                    if resp.status != 204 and resp.status != 200:
                        output_progress(0, 0, 0, f"Webhook发送失败: {resp.status}")
        else:
            # 使用账号发送
            if self.send_channel:
                await self.send_channel.send(self.test_message)

    async def binary_search(self, suspects: List[discord.Member],
                           step: int = 1) -> Optional[discord.Member]:
        """二分搜索找出泄露者"""
        total_steps = math.ceil(math.log2(len(suspects))) + 1 if suspects else 0
        suspect_names = [m.display_name for m in suspects]

        output_progress(step, total_steps, len(suspects),
                       f"当前嫌疑人数: {len(suspects)}", suspect_names)

        if len(suspects) == 0:
            return None

        if len(suspects) == 1:
            output_progress(step, total_steps, 1,
                           f"锁定最终嫌疑人: {suspects[0].display_name}", [suspects[0].display_name])
            return suspects[0]

        mid = len(suspects) // 2
        first_half = suspects[:mid]
        second_half = suspects[mid:]
        first_names = [m.display_name for m in first_half]
        second_names = [m.display_name for m in second_half]

        output_progress(step, total_steps, len(suspects),
                       f"移除前半部分 {len(first_half)} 人的身份组: {', '.join(first_names)}", suspect_names)

        removed_roles = await self.remove_roles_from_members(first_half)
        await asyncio.sleep(1)

        output_progress(step, total_steps, len(suspects),
                       "发送测试消息...", suspect_names)
        await self.send_test_message()

        output_progress(step, total_steps, len(suspects),
                       f"等待泄露消息 ({self.timeout}秒)...", suspect_names)
        leaked = await self.wait_for_leak(timeout=self.timeout)

        # 详细显示监听结果
        if leaked:
            output_progress(step, total_steps, len(suspects),
                           "【监听到泄露消息】", suspect_names)
        else:
            output_progress(step, total_steps, len(suspects),
                           "【未监听到泄露消息】", suspect_names)

        output_progress(step, total_steps, len(suspects),
                       "恢复身份组...", suspect_names)
        await self.restore_roles(removed_roles)

        if leaked:
            output_progress(step, total_steps, len(second_half),
                           f"泄露者在后半部分 ({len(second_half)} 人): {', '.join(second_names)}", second_names)
            return await self.binary_search(second_half, step + 1)
        else:
            output_progress(step, total_steps, len(first_half),
                           f"泄露者在前半部分 ({len(first_half)} 人): {', '.join(first_names)}", first_names)
            return await self.binary_search(first_half, step + 1)

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

            # 设置发送消息的频道
            if self.send_channel_id:
                self.send_channel = self.guild.get_channel(self.send_channel_id)
                if not self.send_channel:
                    output_progress(0, 0, 0, "错误: 找不到发送消息的频道")
                    await self.client.close()
                    return
            else:
                self.send_channel = self.guild.text_channels[0] if self.guild.text_channels else None

            if not self.send_channel and not self.webhook_url:
                output_progress(0, 0, 0, "错误: 没有可用的发送频道或Webhook")
                await self.client.close()
                return

            output_progress(0, 0, len(self.members_with_roles),
                           "开始二分搜索...")

            leaker = await self.binary_search(
                self.members_with_roles
            )

            if leaker:
                self.found_leaker = leaker
                leaker_roles = [r.name for r in leaker.roles if r.name != "@everyone"]
                avatar_url = str(leaker.avatar.url) if leaker.avatar else ""

                # 最终确认：移除嫌疑人身份组，再次验证
                output_progress(0, 0, 1, f"【最终确认】移除 {leaker.display_name} 的身份组...", [leaker.display_name])
                removed_roles = await self.remove_roles_from_members([leaker])
                await asyncio.sleep(1)

                output_progress(0, 0, 1, "【最终确认】发送测试消息...", [leaker.display_name])
                await self.send_test_message()

                output_progress(0, 0, 1, f"【最终确认】等待泄露消息 ({self.timeout}秒)...", [leaker.display_name])
                still_leaked = await self.wait_for_leak(timeout=self.timeout)

                # 恢复身份组
                output_progress(0, 0, 1, "【最终确认】恢复身份组...", [leaker.display_name])
                await self.restore_roles(removed_roles)

                if still_leaked:
                    # 移除后仍然泄露，说明冤枉了
                    output_progress(0, 0, 0, f"【确认失败】移除 {leaker.display_name} 后仍监听到泄露，可能冤枉了此人！", [leaker.display_name])
                    output_result({
                        "id": str(leaker.id),
                        "username": leaker.name,
                        "display_name": leaker.display_name,
                        "avatar": avatar_url,
                        "roles": leaker_roles,
                        "confirmed": False
                    })
                else:
                    # 移除后没有泄露，确认是泄露者
                    output_progress(0, 0, 0, f"【确认成功】移除 {leaker.display_name} 后未监听到泄露，确认是泄露者！", [leaker.display_name])
                    output_result({
                        "id": str(leaker.id),
                        "username": leaker.name,
                        "display_name": leaker.display_name,
                        "avatar": avatar_url,
                        "roles": leaker_roles,
                        "confirmed": True
                    })
            else:
                output_progress(0, 0, 0, "未找到泄露者")

            await self.client.close()

        await self.client.start(self.token)


async def test_connection(token: str):
    """测试Token连接"""
    client = discord.Client()
    result = {"connected": False, "username": ""}

    @client.event
    async def on_ready():
        result["connected"] = True
        result["username"] = f"{client.user.name}#{client.user.discriminator}"
        print(f"CONNECTED:{result['username']}", flush=True)
        # 使用 loop.call_soon 来安排关闭，避免阻塞
        asyncio.get_event_loop().call_soon(lambda: asyncio.create_task(client.close()))

    @client.event
    async def on_connect():
        print("STATUS:正在建立连接...", flush=True)

    try:
        await asyncio.wait_for(client.start(token), timeout=60)
    except asyncio.TimeoutError:
        if not result["connected"]:
            print("连接超时（60秒），请检查网络或Token", file=sys.stderr)
            sys.exit(1)
    except discord.LoginFailure as e:
        print(f"登录失败: Token无效 - {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        # 如果已经连接成功，忽略关闭时的错误
        if result["connected"]:
            sys.exit(0)
        print(f"连接失败: {e}", file=sys.stderr)
        sys.exit(1)

    # 确保正常退出
    if result["connected"]:
        sys.exit(0)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=False)
    parser.add_argument("--test-connection", dest="test_token", required=False)
    args = parser.parse_args()

    if args.test_token:
        # 测试连接模式
        asyncio.run(test_connection(args.test_token))
    elif args.config:
        config = json.loads(args.config)
        tracker = LeakerTracker(config)
        asyncio.run(tracker.run())
    else:
        print("错误: 需要 --config 或 --test-connection 参数", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
