import io
import json
import unittest
from unittest.mock import patch
import agent


class ReviewAgentTests(unittest.TestCase):
    def test_streamed_tool_arguments_are_reassembled(self):
        chunks = [{'choices': [{'delta': {'tool_calls': [{'index': 0, 'id': 'one', 'function': {'name': 'read_project_file', 'arguments': '{"path":'}}]}}]},
                  {'choices': [{'delta': {'tool_calls': [{'index': 0, 'function': {'arguments': '"src/App.tsx"}'}}]}, 'finish_reason': 'tool_calls'}]}]
        stream = io.BytesIO(b''.join(b'data: ' + json.dumps(chunk).encode() + b'\n\n' for chunk in chunks) + b'data: [DONE]\n\n')
        with patch.object(agent, 'trim_context'), patch.object(agent, 'api', return_value=stream):
            result = agent.completion([], agent.REVIEW_TOOLS)
        self.assertEqual(result['tool_calls'][0]['id'], 'one')
        self.assertEqual(json.loads(result['tool_calls'][0]['function']['arguments']), {'path': 'src/App.tsx'})

    def test_review_buffers_raw_tool_syntax_instead_of_displaying_it(self):
        chunks = [{'choices': [{'delta': {'content': '<tool_call><function=read_project_file>'}}]}]
        stream = io.BytesIO(b''.join(b'data: ' + json.dumps(chunk).encode() + b'\n\n' for chunk in chunks) + b'data: [DONE]\n\n')
        with patch.object(agent, 'REVIEW_ROOT', '/tmp'), patch.object(agent, 'trim_context'), patch.object(agent, 'api', return_value=stream), patch.object(agent, 'emit') as emit:
            agent.completion([], agent.REVIEW_TOOLS)
        self.assertFalse(any(call.args and call.args[0] == 'text' for call in emit.call_args_list))

    def test_context_trimming_preserves_current_tool_group(self):
        messages = [{'role': 'system', 'content': 'system'}, {'role': 'user', 'content': 'old'},
                    {'role': 'assistant', 'tool_calls': []}, {'role': 'tool', 'content': 'old result'},
                    {'role': 'user', 'content': 'new'}, {'role': 'assistant', 'tool_calls': []}, {'role': 'tool', 'content': 'new result'}]
        with patch.object(agent, 'api', side_effect=[{'prompt': 'large'}, {'tokens': [0]*7100}, {'prompt': 'small'}, {'tokens': [0]*100}]):
            agent.trim_context(messages, agent.REVIEW_TOOLS)
        self.assertEqual([message['role'] for message in messages], ['system', 'user', 'assistant', 'tool'])
        self.assertEqual(messages[1]['content'], 'new')
